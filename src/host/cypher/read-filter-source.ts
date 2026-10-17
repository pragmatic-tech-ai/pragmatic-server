import type { AccessContext, ITenantConfigStore, ISecurityModelConfig, Principal } from '@pragmatic-tech-ai/todl-identity'
import { PrivilegeAction, AccessLevel } from '@pragmatic-tech-ai/todl-identity'
import type { IInstanceFilter } from '@pragmatic-tech-ai/todl'
import { AccessDepthEvaluator, AccessDepthInstanceFilter, AllowAllInstanceFilter } from '@pragmatic-tech-ai/todl-identity-engine'
import type { FieldSecurityEvaluator, IMembership } from '@pragmatic-tech-ai/todl-identity-engine'
import { AllowAllFieldReadMask } from './field-masked-graph-query.js'
import type { IFieldReadMask } from './field-masked-graph-query.js'
import { AccessDepthWriteInstanceGate } from './write-instance-gate.js'
import type { IWriteInstanceGate } from './write-instance-gate.js'
import type { IWriteTargetSource } from '../write-target-source.js'

/** Produces the ACCESS-DEPTH read filter for a request. One of two impls is chosen by the server per the identity state. */
export interface IReadFilterSource
{
    ReadFilterFor(context: AccessContext): Promise<IInstanceFilter>
}

/** Produces the FIELD-READ mask for a request. One of two impls is chosen by the server per the identity state. */
export interface IFieldReadMaskSource
{
    FieldReadMaskFor(context: AccessContext): Promise<IFieldReadMask>
}

/** Coarse (view-free) per-concept write gate: EffectiveLevel !== None. Per-instance depth is SP-3d. */
export interface IWriteAuthorizer
{
    Allows(concept: string, action: PrivilegeAction): boolean
}

/** Produces the write authorizer for a request. One of two impls is chosen by the server per the identity state. */
export interface IWriteAuthorizerSource
{
    WriteAuthorizerFor(context: AccessContext): Promise<IWriteAuthorizer>
}

class AccessDepthWriteAuthorizer implements IWriteAuthorizer
{
    constructor(private readonly evaluator: AccessDepthEvaluator, private readonly principal: Principal) {}

    public Allows(concept: string, action: PrivilegeAction): boolean
    {
        return this.evaluator.EffectiveLevel(this.principal, action, concept) !== AccessLevel.None
    }
}

class AccessFieldReadMask implements IFieldReadMask
{
    constructor(private readonly evaluator: FieldSecurityEvaluator, private readonly principal: Principal) {}

    public CanRead(concept: string, field: string): boolean
    {
        return this.evaluator.CanReadField(this.principal, concept, field)
    }
}

class AllowAllWriteAuthorizer implements IWriteAuthorizer
{
    public static readonly Instance = new AllowAllWriteAuthorizer()

    public Allows(): boolean
    {
        return true
    }
}

/** No identity subsystem: the write axis is inactive; every concept/action is allowed. */
export class AllowAllWriteAuthorizerSource implements IWriteAuthorizerSource
{
    public static readonly Instance = new AllowAllWriteAuthorizerSource()

    public async WriteAuthorizerFor(): Promise<IWriteAuthorizer>
    {
        return AllowAllWriteAuthorizer.Instance
    }
}

/**
 * Identity configured: builds and caches one AccessDepthEvaluator per tenant from the tenant's
 * SecurityModel (absent/null ⇒ DenyAll, fail-closed), and returns a per-principal depth filter.
 * The SecurityModel is static post-Start (runtime role editing is deferred), so the evaluator is
 * built once per tenant. Cache invalidation on config change is a deferred follow-up.
 */
export class TenantReadAuthorization implements IReadFilterSource, IWriteAuthorizerSource, IFieldReadMaskSource
{
    private readonly evaluators = new Map<string, Promise<AccessDepthEvaluator>>()

    constructor(private readonly store: ITenantConfigStore) {}

    public async ReadFilterFor(context: AccessContext): Promise<IInstanceFilter>
    {
        const evaluator = await this.EvaluatorFor(context.Tenant.Id)
        return new AccessDepthInstanceFilter(evaluator, context.Principal, PrivilegeAction.Read)
    }

    public async WriteAuthorizerFor(context: AccessContext): Promise<IWriteAuthorizer>
    {
        const evaluator = await this.EvaluatorFor(context.Tenant.Id)
        return new AccessDepthWriteAuthorizer(evaluator, context.Principal)
    }

    public async WriteInstanceGateFor(context: AccessContext, predicate: IInstanceFilter, target: IWriteTargetSource): Promise<IWriteInstanceGate>
    {
        const evaluator = await this.EvaluatorFor(context.Tenant.Id)
        return new AccessDepthWriteInstanceGate(evaluator, context.Principal, predicate, target)
    }

    public async FieldReadMaskFor(context: AccessContext): Promise<IFieldReadMask>
    {
        const evaluator = await this.EvaluatorFor(context.Tenant.Id)
        const fs = evaluator.FieldSecurity()
        if (!fs.HasSecuredFields())
        {
            return AllowAllFieldReadMask.Instance
        }
        return new AccessFieldReadMask(fs, context.Principal)
    }

    public async MembershipFor(context: AccessContext): Promise<IMembership>
    {
        const evaluator = await this.EvaluatorFor(context.Tenant.Id)
        return evaluator.MembershipOf(context.Principal)
    }

    public EvaluatorForContext(context: AccessContext): Promise<AccessDepthEvaluator>
    {
        return this.EvaluatorFor(context.Tenant.Id)
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
        const model: ISecurityModelConfig | null | undefined = config?.SecurityModel
        if (model === undefined || model === null)
        {
            return AccessDepthEvaluator.DenyAll()
        }
        return AccessDepthEvaluator.FromConfig(model)
    }
}

/** No identity subsystem: the access-depth axis is inactive (keeps everything; the composite degrades to the predicate filter). */
export class AllowAllReadFilterSource implements IReadFilterSource
{
    public static readonly Instance = new AllowAllReadFilterSource()

    public async ReadFilterFor(): Promise<IInstanceFilter>
    {
        return new AllowAllInstanceFilter()
    }
}

/** No identity subsystem: field security is inactive; every field is readable. */
export class AllowAllFieldReadMaskSource implements IFieldReadMaskSource
{
    public static readonly Instance = new AllowAllFieldReadMaskSource()

    public async FieldReadMaskFor(): Promise<IFieldReadMask>
    {
        return AllowAllFieldReadMask.Instance
    }
}
