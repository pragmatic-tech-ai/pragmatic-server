import { PerUserSourceTokenCache } from '@pragmatic-tech-ai/todl-identity'
import type { ISourceTokenProvider, SourceToken, SourceTokenRequest } from '@pragmatic-tech-ai/todl-identity'

/**
 * The identity pack's source-token provider behind a per-user cache (tenant, principal, resource; dropped a minute
 * before expiry): repeated connector calls of one caller reuse its token, so its connection is reopened only when the
 * token is renewed. `Forget` drops one principal's cached tokens (deprovisioning, sign-out: ruling R27). A failed
 * acquisition is never cached.
 */
export class CallerSourceTokens implements ISourceTokenProvider
{
    public constructor(private readonly inner: ISourceTokenProvider, private readonly cache: PerUserSourceTokenCache = new PerUserSourceTokenCache())
    {
    }

    public async Acquire(request: SourceTokenRequest): Promise<SourceToken>
    {
        const cached = this.cache.Get(request, new Date())
        if (cached !== undefined) return cached
        const token = await this.inner.Acquire(request)
        this.cache.Put(request, token)
        return token
    }

    /** Drops every cached token of `principalId` in `tenantId`. */
    public Forget(tenantId: string, principalId: string): void
    {
        this.cache.Forget(tenantId, principalId)
    }
}
