import { isIP } from 'node:net'
import { checkServerIdentity } from 'node:tls'
import type { PeerCertificate } from 'node:tls'

/** The TLS options that name a worker on the gateway's outbound leg. */
export interface WorkerTlsNameOptions
{
    servername: string | undefined
    checkServerIdentity?: (host: string, cert: PeerCertificate) => Error | undefined
}

/**
 * How the gateway names a worker over TLS. A DNS name goes out as SNI and is what the worker certificate is checked
 * against. An IP address cannot be sent as SNI (newer Node refuses an IP `servername` outright), so it goes out
 * without SNI and the certificate is still checked against that IP, never against the dialled host.
 */
export class WorkerTlsName
{
    private static readonly NoSni = ''

    public static OptionsFor(serverName: string | undefined): WorkerTlsNameOptions
    {
        if (serverName === undefined || isIP(serverName) === 0)
        {
            return { servername: serverName }
        }
        return { servername: WorkerTlsName.NoSni, checkServerIdentity: (_host, cert) => checkServerIdentity(serverName, cert) }
    }
}
