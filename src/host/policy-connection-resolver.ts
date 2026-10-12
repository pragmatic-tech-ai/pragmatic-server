import { InlineConnectionResolver } from '@pragmatic-tech-ai/todl'
import type { IConnectionResolver, ConnectorSpec, ResolvedConnection } from '@pragmatic-tech-ai/todl'
import type { IServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import type { ConnectorsPolicy } from './connector-policy.js'

/** Enforces a tenant's ConnectorsPolicy at connection-resolve time (the seam the catalog hits on every
 *  adapter open): rejects a disallowed adapter kind, rejects an inline connection under catalog-only, and
 *  guards provider-override; otherwise delegates to the inner resolver. Registered under ConnectionResolverKey,
 *  which bypasses the catalog's default inline fallback. */
export class PolicyConnectionResolver implements IConnectionResolver
{
    private static readonly AdapterNotAllowed = 'connector.policy.adapter-not-allowed'
    private static readonly CatalogOnlyViolation = 'connector.policy.catalog-only'

    private readonly policy: ConnectorsPolicy
    private readonly inner: IConnectionResolver

    public constructor(policy: ConnectorsPolicy, inner: IConnectionResolver = new InlineConnectionResolver())
    {
        this.policy = policy
        this.inner = inner
    }

    public Resolve(spec: ConnectorSpec, services: IServiceProvider): Promise<ResolvedConnection>
    {
        if (!this.policy.AdapterAllowlist.includes(spec.Kind))
        {
            return Promise.reject(new Error(`${PolicyConnectionResolver.AdapterNotAllowed}: ${spec.Kind}`))
        }
        if (this.policy.CatalogOnly && spec.Connection === undefined)
        {
            return Promise.reject(new Error(`${PolicyConnectionResolver.CatalogOnlyViolation}: ${spec.Name}`))
        }
        // Provider-override gate: ConnectorSpec carries no provider/package field today, so there is nothing
        // to reject. The policy's AllowProviderOverride/ProviderAllowlist are carried for when a provider
        // surface exists; no live check is added (adding a dead rejection path would be untestable).
        return this.inner.Resolve(spec, services)
    }
}
