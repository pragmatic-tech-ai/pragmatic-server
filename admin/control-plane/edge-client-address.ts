import type { IncomingMessage } from 'node:http'

/** The client address the edge throttles on: the socket peer, or (behind a trusted proxy such as Caddy) the last
 *  X-Forwarded-For hop, the one the proxy itself appended, but only when it looks like an IP address. */
export class EdgeClientAddress
{
    private static readonly ForwardedForHeader = 'x-forwarded-for'
    private static readonly HopSeparator = ','
    private static readonly AddressShape = /^[0-9A-Fa-f:.]{1,64}$/
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
        return E.AddressShape.test(last) ? last : socket
    }
}
