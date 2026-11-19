import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'

/** The client address the edge throttles on: the socket peer, or (behind a trusted proxy such as Caddy) the last
 *  X-Forwarded-For hop, the one the proxy itself appended, but only when it is a valid IP address. */
export class EdgeClientAddress
{
    private static readonly ForwardedForHeader = 'x-forwarded-for'
    private static readonly HopSeparator = ','
    private static readonly Unknown = ''

    public static Of(req: IncomingMessage, trustedProxy: boolean): string
    {
        const E = EdgeClientAddress
        const socket = req.socket?.remoteAddress ?? E.Unknown
        if (!trustedProxy)
        {
            return socket
        }
        const header = req.headers[E.ForwardedForHeader]
        const value = Array.isArray(header) ? header[header.length - 1] : header
        const last = value?.split(E.HopSeparator).pop()?.trim() ?? E.Unknown
        return isIP(last) !== 0 ? last : socket
    }
}
