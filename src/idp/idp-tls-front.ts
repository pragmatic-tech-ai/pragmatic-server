import { createServer, type Server as TlsServer, type TLSSocket } from 'node:tls';
import type { AddressInfo } from 'node:net';
import type { AppHost } from '@pragmatic-tech-ai/pragmatic-app-host';
import { AppHostServer } from './app-host-server.js';

/** The key and certificate the service serves TLS with (PEM). */
export class IdpTlsIdentity
{
    public constructor(public readonly Key: Buffer, public readonly Cert: Buffer)
    {
    }
}

/**
 * Serves an AppHost over TLS until pragmatic-app-host has a TLS option (gap G2 in the plan's Ledger): the host listens on
 * an ephemeral loopback port (never used for traffic), and this TLS listener hands every secured connection to the
 * host's node server as a connection of its own, so the host's whole pipeline runs over TLS (its Origin guard sees an
 * encrypted socket). Closing stops the TLS listener; the host closes its own connections.
 */
export class IdpTlsFront
{
    private static readonly LoopbackHost = '127.0.0.1';
    private static readonly EphemeralPort = 0;
    private static readonly ConnectionEvent = 'connection';
    private static readonly ErrorEvent = 'error';
    private static readonly NotListeningMessage = 'IdpTlsFront is not listening';

    private server: TlsServer | undefined;

    public constructor(private readonly host: AppHost, private readonly identity: IdpTlsIdentity)
    {
    }

    public async Listen(port: number, bind: string): Promise<void>
    {
        const F = IdpTlsFront;
        await this.host.Listen(F.EphemeralPort, F.LoopbackHost);
        const http = AppHostServer.Of(this.host);
        const server = createServer({ key: this.identity.Key, cert: this.identity.Cert }, (socket: TLSSocket) =>
        {
            http.emit(F.ConnectionEvent, socket);
        });
        await new Promise<void>((resolve, reject) =>
        {
            server.once(F.ErrorEvent, reject);
            server.listen(port, bind, () =>
            {
                server.off(F.ErrorEvent, reject);
                resolve();
            });
        });
        this.server = server;
    }

    public Address(): { address: string; port: number }
    {
        const address = this.server?.address() as AddressInfo | null | undefined;
        if (address === null || address === undefined)
        {
            throw new Error(IdpTlsFront.NotListeningMessage);
        }
        return { address: address.address, port: address.port };
    }

    public async Close(): Promise<void>
    {
        const server = this.server;
        this.server = undefined;
        const closed = server === undefined ? Promise.resolve() : new Promise<void>(resolve => server.close(() => resolve()));
        await this.host.Close();
        await closed;
    }
}
