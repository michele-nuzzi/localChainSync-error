import { Cbor, CborObj, CborArray, CborTag, CborBytes, LazyCborArray, LazyCborObj } from "@harmoniclabs/cbor";
import { ChainPoint, ChainSyncClient, MiniProtocol, Multiplexer, N2CHandshakeVersion, N2CMessageAcceptVersion, N2CMessageProposeVersion, n2cHandshakeMessageFromCbor, unwrapMultiplexerMessage } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { createHash } from "blake2";
import { Socket, connect } from "net";

void async function main()
{
    const mplexer = new Multiplexer(
        {
            connect: () => connect({ path: process.env.CARDANO_NODE_SOCKET_PATH ?? process.argv[2] ?? "" }),
            protocolType: "node-to-client"
        }
    );

    // make sure we log every data we receive BEFORE processing it
    (mplexer.socket.unwrap() as Socket)
    .prependListener("data", chunk => {

        console.log("------------------------------------------------------ socket data ------------------------------------------------------\n");
        console.log( toHex( chunk ) );
        const { header, payload } = unwrapMultiplexerMessage( chunk );
        console.log( header );
    });

    const chainSyncClient = new ChainSyncClient( mplexer );

    // log when we receive something
    chainSyncClient.on("error", err => { throw err; } );
    chainSyncClient.on("awaitReply"         ,() => console.log("awaitReply") );
    chainSyncClient.on("intersectFound"     ,() => console.log("intersectFound") );
    chainSyncClient.on("intersectNotFound"  ,() => console.log("intersectNotFound") );
    chainSyncClient.on("rollBackwards"      ,() => console.log("rollBackwards") );
    chainSyncClient.on("rollForward"        ,() => console.log("rollForward") );

    // handshake
    await new Promise<void>(( resolve => {
        mplexer.onHandshake( chunk => {

            const msg = n2cHandshakeMessageFromCbor( chunk );

            if( msg instanceof N2CMessageAcceptVersion )
            {
                // @ts-ignore
                mplexer.clearListeners( MiniProtocol.Handshake );
                console.log( "connected to node" );
                resolve();
            }
            else {
                console.error( msg );
                throw new Error("TODO: handle rejection")
            }
        });

        mplexer.send(
            new N2CMessageProposeVersion({
                versionTable: [
                    {
                        version: N2CHandshakeVersion.v10,
                        data: {
                            networkMagic: 1
                        }
                    }
                ]
            }).toCbor().toBuffer(),
            {
                hasAgency: true,
                protocol: MiniProtocol.Handshake
            }
        );
    }));

    // go 2 blocks before `83479b49f7dc70293195ad29c547a437cd7c67cbe27b033146275023200e5154`
    await new Promise<void>( res => {
        // resolve after rollBack (to intersection)
        chainSyncClient.once("rollBackwards", () => res() );
        
        // on intersection found (we know it exsists) trigger request next (in order to receive rollback)
        chainSyncClient.once("intersectFound", _ => chainSyncClient.requestNext() );

        // trigger find intersect two blocks before the fat one
        chainSyncClient.findIntersect([{
            blockHeader: {
                hash: fromHex( "35af5a4cfaf14d0783f21963926b0422dde37f570274faa4ed83f32938fbf07c" ),
                slotNumber: 41084896
            }
        }]);
    })

    //*
    chainSyncClient.on("rollForward", rollForward => {

        const blockData: Uint8Array = rollForward.cborBytes ?
            rollForwardBytesToBlockData( rollForward.cborBytes, rollForward.blockData ) : 
            Cbor.encode( rollForward.blockData ).toBuffer();

        const lazyBlock = Cbor.parseLazy( blockData );

        if(!( lazyBlock instanceof LazyCborArray ))
        {
            throw new Error("blockData not array");
        }
    
        const headerData = lazyBlock.array[0];
    
        let hash = blake2b_256( headerData );
        
        // never logs "83479b49f7dc70293195ad29c547a437cd7c67cbe27b033146275023200e5154"
        // because the message is never complete
        // and because is never complete is never emitted
        console.log("rollForward to block " + hash )
    });

    let timeout: NodeJS.Timeout

    // keep requesting
    while( true )
    {
        await new Promise<void>( _resolve => {

            timeout = setTimeout(() => {

                console.log("unresolved after 5 second");
                // chainSyncClient.removeEventListener("rollForward", resolveFroward);
                // chainSyncClient.removeEventListener("rollBackwards", resolveBackwards);

                // will cause to concatenate new (valid on its own) message to previous (truncated) bytes
                // ultimately throwin an error at line 29
                // (`chainSyncClient.on("error", err => { throw err; } );`)
                chainSyncClient.requestNext();
            }, 5_000);

            function resolveBackwards()
            {
                clearTimeout( timeout );
                chainSyncClient.removeEventListener("rollForward", resolveFroward);
                _resolve();
            }

            function resolveFroward()
            {
                clearTimeout( timeout );
                chainSyncClient.removeEventListener("rollBackwards", resolveBackwards);
                _resolve();
            }

            // chainSyncClient.on("awaitReply", () => {})
            chainSyncClient.once("rollBackwards", resolveBackwards);
            chainSyncClient.once("rollForward", resolveFroward);

            chainSyncClient.requestNext();
        });

    }
    
}()

function rollForwardBytesToBlockData( bytes: Uint8Array, defaultCborObj: CborObj ): Uint8Array
{
    let cbor: CborObj | LazyCborObj
    
    try {
        cbor = Cbor.parse( bytes );
    }
    catch {
        return Cbor.encode( defaultCborObj ).toBuffer();
    }
    
    if(!(
        cbor instanceof CborArray &&
        cbor.array[1] instanceof CborTag && 
        cbor.array[1].data instanceof CborBytes
    ))
    {
        return Cbor.encode( defaultCborObj ).toBuffer();
    }

    cbor = Cbor.parseLazy( cbor.array[1].data.buffer );

    if(!( cbor instanceof LazyCborArray ))
    {
        return Cbor.encode( defaultCborObj ).toBuffer();
    }

    return cbor.array[1];
}

function blake2b_256( data: Uint8Array )
{
    return createHash("blake2b", { digestLength: 32 }).update(Buffer.from( data )).digest("hex")
}