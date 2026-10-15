import type { AccessContext, ITenantConfigStore, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { IInstanceFilter } from '@pragmatic-tech-ai/todl'
import { AccessDepthEvaluator, AccessDepthInstanceFilter, AllowAllInstanceFilter } from '@pragmatic-tech-ai/todl-identity-engine'

/** Produces the ACCESS-DEPTH read filter for a request. One of two impls is chosen by the server per the identity state. */
export interface IReadFilterSource
{
    ReadFilterFor(context: AccessContext): Promise<IInstanceFilter>
}

/**
 * Identity configured: builds and caches one AccessDepthEvaluator per tenant from the tenant's
 * SecurityModel (absent/null ⇒ DenyAll, fail-closed), and returns a per-principal depth filter.
 * The SecurityModel is static post-Start (runtime role editing is deferred), so the evaluator is
 * built once per tenant. Cache invalidation on config change is a deferred follow-up.
 */
export class TenantReadAuthorization implements IReadFilterSource
{
    private readonly evaluators = new Map<string, Promise<AccessDepthEvaluator>>()

    constructor(private readonly store: ITenantConfigStore) {}

    public async ReadFilterFor(context: AccessContext): Promise<IInstanceFilter>
    {
        const evaluator = await this.EvaluatorFor(context.Tenant.Id)
        return new AccessDepthInstanceFilter(evaluator, context.Principal, PrivilegeAction.Read)
    }

    private EvaluatorFor(tenantId: string): Promise<AccessDepthEvaluator>
    {
        let built = this.evaluators.get(tenantId)
        if (built === undefined)
        {
            built = this.Build(tenantId)
            this.evaluators.set(tenantId, built)
            // Evict a failed build so a later call retries (concurrent callers share the in-flight promise).
            built.catch(() =>
            {
                if (this.evaluators.get(tenantId) === built)
                {
                    this.evaluators.delete(tenantId)
                }
            })
        }
        return built
    }

    private async Build(tenantId: string): Promise<AccessDepthEvaluator>
    {
        const config = await this.store.Get(tenantId)
        const model: ISecurityModelConfig | undefined = config?.SecurityModel
        return model === undefined ? AccessDepthEvaluator.DenyAll() : AccessDepthEvaluator.FromConfig(model)
    }
}

/** No identity subsystem: the access-depth axis is inactive (keeps everything; the composite degrades to the predicate filter). */
export class AllowAllReadFilterSource implements IReadFilterSource
{
    public static readonly Instance = new AllowAllReadFilterSource()

    public async ReadFilterFor(context: AccessContext): Promise<IInstanceFilter>
    {
        return new AllowAllInstanceFilter()
    }
}
