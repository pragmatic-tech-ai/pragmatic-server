import type { IncomingMessage } from 'node:http'

/**
 * The end user's address on the tenant plane, for per-address throttles. Behind a trusted proxy
 * (PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY) it is the last x-forwarded-for hop, and only when that looks like an IP address;
 * otherwise (no trusted proxy, or no plausible hop) it is the socket's peer. Without a trusted proxy the header is ignored,
 * so a client cannot pick its own throttle bucket.
 */
export class TenantClientAddress
{
    private static readonly ForwardedForHeader = 'x-forwarded-for'
    private static readonly ForwardedSeparator = ','
    private static readonly NoAddress = ''
    private static readonly PlausibleIp = /^[0-9A-Fa-f:.]{1,64}$/

    public static Of(req: IncomingMessage, trustedProxy: boolean): string
    {
        if (trustedProxy)
        {
            const raw = req.headers[TenantClientAddress.ForwardedForHeader]
            const header = Array.isArray(raw) ? raw.join(TenantClientAddress.ForwardedSeparator) : raw
            const last = header?.split(TenantClientAddress.ForwardedSeparator).pop()?.trim()
            if (last !== undefined && TenantClientAddress.PlausibleIp.test(last))
            {
                return last
            }
        }
        return req.socket?.remoteAddress ?? TenantClientAddress.NoAddress
    }
}
