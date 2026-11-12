import type { AccessScope, ISubscription } from '@pragmatic-tech-ai/graph'
import { AccessContext, ResourceAuthorizationPolicy, SystemPrincipal } from '@pragmatic-tech-ai/todl-identity'
import type { Tenant } from '@pragmatic-tech-ai/todl-identity'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import type { IGraphScope, IGraphScopeSource } from '../engine/access-scope-source.js'
import type { EnvironmentScopeRules } from './environment-scope-rules.js'

/**
 * The scope of work no user started. Today that is the deploy ownership backfill; any future background work
 * (connector population, scheduled flows, agents, identity resolution) must run under it too. It is the environment's
 * system principal (`SystemPrincipal.For(tenant.Id)`, C7), System Administrator at the
 * root business unit by the tier-1 compiler, so it reads every record and secured field and its creates are owned by
 * `system:<environment>` in the root unit. Its AccessContext carries no RBAC grants: it never passes the PolicyGate and
 * exists only in-process. Its connector calls run under `CallerConnectorContext.System(tenant)` (the scope source keys
 * the context by the principal id, which is the system id).
 *
 * `Scope()` is memoized until the scope source drops its compiled scopes (a security reload or an engine upgrade):
 * the next call compiles a fresh scope with the same rights. Disposed with the server before the scope source.
 */
export class SystemPrincipalScope implements IDisposable
{
    /**
     * The id namespace no account or external identity may take. Mirrors todl-identity's `SystemPrincipal.IsReserved`
     * (whose prefix constant is private there); checks use `SystemPrincipal.IsReserved`, this names the namespace.
     */
    public static readonly ReservedPrefix = 'system:'

    private readonly context: AccessContext
    private readonly dropped: ISubscription
    private scope: Promise<IGraphScope> | undefined

    public constructor(private readonly scopes: IGraphScopeSource, private readonly rules: EnvironmentScopeRules, tenant: Tenant)
    {
        this.context = new AccessContext(SystemPrincipal.For(tenant.Id), tenant, [], new ResourceAuthorizationPolicy())
        this.dropped = scopes.Dropped.Subscribe(() => this.Forget())
    }

    /** `system:<environment>`: the owner the system principal's writes and the deploy ownership backfill record. */
    public get PrincipalId(): string
    {
        return this.context.Principal.Id
    }

    /** The system principal's engine scope (memoized per scope-source generation; a failed build is retried). */
    public Scope(): Promise<IGraphScope>
    {
        if (this.scope === undefined)
        {
            const built = this.scopes.ScopeFor(this.context)
            this.scope = built
            built.catch(() =>
            {
                if (this.scope === built) this.scope = undefined
            })
        }
        return this.scope
    }

    /** `rules.AssignRecords` for the system principal (PR2): unrestricted, the system fields writable. */
    public async AssignScope(): Promise<AccessScope>
    {
        return this.rules.AssignRecords(this.context, await this.rules.Snapshot())
    }

    public dispose(): void
    {
        this.dropped.dispose()
        this.Forget()
    }

    private Forget(): void
    {
        this.scope = undefined
    }
}
