import type { AccessContext, ITenantConfigStore, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { AccessDepthEvaluator } from '@pragmatic-tech-ai/todl-identity-engine'
import type { ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { Signal } from '@pragmatic-tech-ai/todl-runtime'

/** Drops a tenant's cached access evaluator so the next request re-reads its SecurityModel from the store (live reload, no restart). */
export interface ISecurityModelReload
{
    Invalidate(environmentId: string): void
}

/** One tenant's cached access evaluator and whether it came from a real SecurityModel (else DenyAll, fail-closed). */
class TenantSecurity
{
    private constructor(public readonly Evaluator: AccessDepthEvaluator, public readonly HasSecurityModel: boolean)
    {
    }

    public static DenyAll(): TenantSecurity
    {
        return new TenantSecurity(AccessDepthEvaluator.DenyAll(), false)
    }

    public static From(config: ISecurityModelConfig): TenantSecurity
    {
        return new TenantSecurity(AccessDepthEvaluator.FromConfig(config), true)
    }
}

/** The subscribe side of the reload signal: raised with the environment id after each Invalidate. */
class SecurityModelInvalidated implements ISignal<string>
{
    private readonly signal = new Signal<string>()

    public Subscribe(handler: (environmentId: string) => void): ISubscription
    {
        return this.signal.subscribe(handler)
    }

    public Raise(environmentId: string): void
    {
        this.signal.emit(environmentId)
    }
}

/**
 * Identity configured: builds and caches one AccessDepthEvaluator per tenant from the tenant's
 * SecurityModel (absent/null ⇒ DenyAll, fail-closed); the scope rules compile it into each caller's engine scope.
 * The evaluator is built once per tenant and reused; a runtime SecurityModel change calls Invalidate
 * to drop the cached evaluator so the next request re-reads the store — live, without a restart.
 * `Invalidated` is raised after each Invalidate so per-principal caches built on the evaluator drop too.
 */
export class TenantReadAuthorization implements ISecurityModelReload
{
    public readonly Invalidated: ISignal<string>

    private readonly securities = new Map<string, Promise<TenantSecurity>>()
    private readonly invalidated = new SecurityModelInvalidated()

    constructor(private readonly store: ITenantConfigStore)
    {
        this.Invalidated = this.invalidated
    }

    public async HasSecurityModelFor(context: AccessContext): Promise<boolean>
    {
        return (await this.SecurityOf(context.Tenant.Id)).HasSecurityModel
    }

    public EvaluatorForContext(context: AccessContext): Promise<AccessDepthEvaluator>
    {
        return this.EvaluatorFor(context.Tenant.Id)
    }

    public Invalidate(environmentId: string): void
    {
        this.securities.delete(environmentId)
        this.invalidated.Raise(environmentId)
    }

    private async EvaluatorFor(environmentId: string): Promise<AccessDepthEvaluator>
    {
        return (await this.SecurityOf(environmentId)).Evaluator
    }

    private SecurityOf(environmentId: string): Promise<TenantSecurity>
    {
        let built = this.securities.get(environmentId)
        if (built === undefined)
        {
            built = this.Build(environmentId)
            this.securities.set(environmentId, built)
            // Evict a failed build so a later call retries (concurrent callers share the in-flight promise).
            built.catch(() =>
            {
                if (this.securities.get(environmentId) === built)
                {
                    this.securities.delete(environmentId)
                }
            })
        }
        return built
    }

    private async Build(environmentId: string): Promise<TenantSecurity>
    {
        const config = await this.store.Get(environmentId)
        const model: ISecurityModelConfig | null | undefined = config?.SecurityModel
        if (model === undefined || model === null)
        {
            return TenantSecurity.DenyAll()
        }
        return TenantSecurity.From(model)
    }
}
