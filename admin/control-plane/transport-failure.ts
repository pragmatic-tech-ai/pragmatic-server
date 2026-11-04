/**
 * Recognises a dial that failed at the TCP level (refused, reset, timed out): through a pooled cluster tunnel that means
 * the forward itself is dead (its pod went away), not that the environment answered badly. Looks at the error's own code
 * and at its cause's (fetch wraps the socket error as `cause`).
 */
export class TransportFailure
{
    private static readonly Codes: ReadonlySet<string> = new Set([
        'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
        'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
    ])

    public static Is(err: unknown): boolean
    {
        return TransportFailure.HasCode(err) || (err instanceof Error && TransportFailure.HasCode(err.cause))
    }

    private static HasCode(err: unknown): boolean
    {
        const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
        return typeof code === 'string' && TransportFailure.Codes.has(code)
    }
}
