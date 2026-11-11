import type { ISchemaDescription, ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import { AccessScopeError, AccessScopeErrorCode } from './access-scope-source.js'
import type { IPreparedRules, IScopeRules, ITenantSecuritySource, ScopeSchema } from './access-scope-source.js'

/** The subscribe side of the rules' change signal (raised when the tenant security model is invalidated). */
class RulesChanged implements ISignal<void>
{
    private readonly signal = new Signal<void>()

    public Subscribe(handler: (value: void) => void): ISubscription
    {
        return this.signal.subscribe(handler)
    }

    public Raise(): void
    {
        this.signal.emit(undefined)
    }
}

/**
 * The identity state every purpose's scope rules share (DevScopeRules, EnvironmentScopeRules): the tenant security
 * source (absent without identity; identity configured without one is refused at construction, AccessScopeError
 * MissingSecuritySource), the security generation (`Invalidated` bumps it and raises `Changed`, so scopes and cursors
 * minted before a security-model reload are superseded) and the read of the host snapshot that belongs to the schema
 * a scope is compiled against (an upgrade racing it is re-read, then SchemaUnsettled).
 *
 * The generation is per process: after a restart or a lease move it starts again at 0, so a cursor minted before a
 * security edit on the previous holder is not staled by it. That is not a leak: every page re-applies the scope
 * compiled from the current security model.
 */
export abstract class SecuredScopeRules<TSnapshot extends { readonly Description: ISchemaDescription }> implements IScopeRules
{
    private static readonly MaxSnapshotReads = 5

    public readonly Changed: ISignal<void>

    protected readonly security: ITenantSecuritySource | undefined
    private readonly changed = new RulesChanged()
    private readonly subscription: ISubscription | undefined
    private generation = 0

    protected constructor(security: ITenantSecuritySource | undefined, identityConfigured: boolean)
    {
        this.Changed = this.changed
        if (identityConfigured && security === undefined) throw new AccessScopeError(AccessScopeErrorCode.MissingSecuritySource)
        this.security = identityConfigured ? security : undefined
        this.subscription = this.security?.Invalidated.Subscribe(() =>
        {
            this.generation += 1
            this.changed.Raise()
        })
    }

    public abstract Prepare(schema: ScopeSchema): Promise<IPreparedRules>

    public dispose(): void
    {
        this.subscription?.dispose()
    }

    /** The security generation, as a prepared rules' Digest. */
    protected get Generation(): string
    {
        return String(this.generation)
    }

    /** The host's current snapshot. */
    protected abstract Snapshot(): Promise<TSnapshot>

    /** The snapshot of `schema`'s version, so its catalog and the schema agree; an upgrade racing it is re-read. */
    protected async SnapshotOf(schema: ScopeSchema): Promise<TSnapshot>
    {
        for (let attempt = 0; attempt < SecuredScopeRules.MaxSnapshotReads; attempt++)
        {
            const snapshot = await this.Snapshot()
            if (snapshot.Description.Version === schema.Version) return snapshot
            await SecuredScopeRules.Yield()
        }
        throw new AccessScopeError(AccessScopeErrorCode.SchemaUnsettled)
    }

    private static Yield(): Promise<void>
    {
        return new Promise<void>(resolve => setImmediate(resolve))
    }
}
