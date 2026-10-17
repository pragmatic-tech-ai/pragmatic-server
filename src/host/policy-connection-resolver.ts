import { InlineConnectionResolver, DataSourceKind } from '@pragmatic-tech-ai/todl'
import type { IConnectionResolver, ConnectorSpec, ResolvedConnection } from '@pragmatic-tech-ai/todl'
import type { IServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import type { ConnectorsPolicy } from './connector-policy.js'

/** Enforces a tenant's ConnectorsPolicy at connection-resolve time (the seam the catalog hits on every
 *  adapter open): rejects a disallowed adapter kind; under catalog-only, inline resolution is never used —
 *  an unnamed spec is rejected, and a named spec resolves only when a catalog resolver is injected (the
 *  deferred named-connection catalog). With no such resolver a catalog-only tenant can open no connector
 *  (fail-closed). Otherwise delegates to the inner resolver. The provider-override fields
 *  (AllowProviderOverride/ProviderAllowlist) are NOT enforced here: ConnectorSpec.Provider now exists, and that
 *  gate is enforced by the composed NpmAdapterPackProvider, which runs earlier (the catalog resolves the adapter
 *  factory before this resolver is hit). Registered under ConnectionResolverKey, which bypasses the catalog's
 *  default inline fallback. */
export class PolicyConnectionResolver implements IConnectionResolver
{
    private static readonly AdapterNotAllowed = 'connector.policy.adapter-not-allowed'
    private static readonly CatalogOnlyViolation = 'connector.policy.catalog-only'

    private readonly policy: ConnectorsPolicy
    private readonly inner: IConnectionResolver
    private readonly hasCatalogResolver: boolean

    public constructor(policy: ConnectorsPolicy, inner?: IConnectionResolver)
    {
        this.policy = policy
        this.inner = inner ?? new InlineConnectionResolver()
        this.hasCatalogResolver = inner !== undefined
    }

    public Resolve(spec: ConnectorSpec, services: IServiceProvider): Promise<ResolvedConnection>
    {
        // The built-in default store is server-internal (a local file/SQLite under the tenant's own data root:
        // no external reach, no credential), so it is exempt from the external-adapter policy.
        if (spec.Kind === DataSourceKind.Builtin)
        {
            return this.inner.Resolve(spec, services)
        }
        if (!this.policy.AdapterAllowlist.includes(spec.Kind))
        {
            return Promise.reject(new Error(`${PolicyConnectionResolver.AdapterNotAllowed}: ${spec.Kind}`))
        }
        if (this.policy.CatalogOnly && (spec.Connection === undefined || !this.hasCatalogResolver))
        {
            return Promise.reject(new Error(`${PolicyConnectionResolver.CatalogOnlyViolation}: ${spec.Name}`))
        }
        // Provider-override gate: ConnectorSpec.Provider exists, but AllowProviderOverride/ProviderAllowlist are
        // enforced by the composed NpmAdapterPackProvider gate, which runs before this resolver (the catalog
        // resolves the factory first). Deliberately no rejection path here.
        return this.inner.Resolve(spec, services)
    }
}
