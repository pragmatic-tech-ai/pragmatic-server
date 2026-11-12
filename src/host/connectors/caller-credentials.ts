import type { ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import type { IDataSourceAdapterFactory } from '@pragmatic-tech-ai/todl'
import { Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import type { ISourceTokenProvider } from '@pragmatic-tech-ai/todl-identity'
import { UnsupportedSourceTokenProvider } from '@pragmatic-tech-ai/todl-identity-cloud'
import type { UpstreamTokenVault } from '@pragmatic-tech-ai/todl-identity-cloud'
import { CallerCredentialAdapterFactory } from './caller-credential-adapter-factory.js'
import type { ICallerCredentialWrapper } from './caller-credential-adapter-factory.js'
import { NullLogger } from '../../observability/logger.js'
import type { ILogger } from '../../observability/logger.js'
import { CallerSourceTokens } from './caller-source-tokens.js'

/** Revokes a principal's per-user source credentials (ruling R27): on deprovisioning and on sign-out. */
export interface ICallerCredentialRevoker
{
    /** Never rejects: a failure is logged by error name (never its message: it may come from a secret store). */
    Revoke(principalId: string): Promise<void>
}

/**
 * The server's per-user source credentials (PR12, R27): wraps every data-source adapter factory the tenant's
 * connectors use in a {@link CallerCredentialAdapterFactory} over the identity pack's source tokens (behind a per-user
 * cache), and revokes one principal's credentials: its stored upstream tokens (todl-identity-cloud UpstreamTokenVault,
 * where the pack stores them), its cached source tokens and every caller's-identity inner adapter opened for it.
 *
 * Unbound (before Start, or without identity) every source-token request is refused (UnsupportedPrincipal): a
 * caller's-identity connection never falls back to app credentials.
 */
export class CallerCredentials implements ICallerCredentialWrapper, ICallerCredentialRevoker
{
    private static readonly UnboundTenantId = 'unbound'
    private static readonly RevokeFailedLine = 'caller credentials: revoke failed: '
    private static readonly UnknownName = 'unknown'

    private tokens = new CallerSourceTokens(new UnsupportedSourceTokenProvider())
    private tenant = new Tenant(CallerCredentials.UnboundTenantId, TenantKind.SelfHosted, CallerCredentials.UnboundTenantId)
    private vault: UpstreamTokenVault | undefined
    private readonly wrapped = new Map<IDataSourceAdapterFactory, CallerCredentialAdapterFactory>()

    public constructor(private readonly logger: ILogger = new NullLogger())
    {
    }

    /** Binds the tenant's identity: factories wrapped from now on acquire through `tokens` (Start). */
    public Bind(tokens: ISourceTokenProvider, tenant: Tenant, vault: UpstreamTokenVault | undefined): void
    {
        this.tokens = new CallerSourceTokens(tokens)
        this.tenant = tenant
        this.vault = vault
        this.wrapped.clear()
    }

    /** `factory` wrapped (one wrapper per factory and binding). */
    public Wrap(factory: IDataSourceAdapterFactory): CallerCredentialAdapterFactory
    {
        let wrapper = this.wrapped.get(factory)
        if (wrapper === undefined)
        {
            wrapper = new CallerCredentialAdapterFactory(factory, this.tokens, this.tenant)
            this.wrapped.set(factory, wrapper)
        }
        return wrapper
    }

    // Revoke drops the caller's cached source tokens here and in the pack provider's own cache (R34).
    public async Revoke(principalId: string): Promise<void>
    {
        this.tokens.Forget(this.tenant.Id, principalId)
        try
        {
            await Promise.all([...this.wrapped.values()].map(wrapper => wrapper.Forget(principalId)))
            await this.vault?.Delete(this.tenant.Id, principalId)
        }
        catch (error)
        {
            this.logger.Warn(CallerCredentials.RevokeFailedLine + (error instanceof Error ? error.name : CallerCredentials.UnknownName))
        }
    }

    /** Revokes every principal `deprovisioned` raises (the IdP directory sync, R27). Dispose the subscription to stop. */
    public Follow(deprovisioned: ISignal<readonly string[]>): ISubscription
    {
        return deprovisioned.Subscribe(ids => void this.RevokeAll(ids))
    }

    private async RevokeAll(ids: readonly string[]): Promise<void>
    {
        for (const id of ids) await this.Revoke(id)
    }
}
