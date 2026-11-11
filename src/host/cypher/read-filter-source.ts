import type { AccessContext, ITenantConfigStore, ISecurityModelConfig, Principal } from '@pragmatic-tech-ai/todl-identity'
import { PrivilegeAction, AccessLevel } from '@pragmatic-tech-ai/todl-identity'
import type { IInstanceFilter } from '@pragmatic-tech-ai/todl'
import { AccessDepthEvaluator, AccessDepthInstanceFilter, AllowAllInstanceFilter } from '@pragmatic-tech-ai/todl-identity-engine'
import type { ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { FieldSecurityEvaluator, IMembership } from '@pragmatic-tech-ai/todl-identity-engine'
import { AllowAllFieldReadMask } from './field-read-mask.js'
import type { IFieldReadMask } from './field-read-mask.js'
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

/** Drops a tenant's cached access evaluator so the next request re-reads its SecurityModel from the store (live reload, no restart). */
export interface ISecurityModelReload
{
    Invalidate(environmentId: string): void
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
 * SecurityModel (absent/null ⇒ DenyAll, fail-closed), and returns a per-principal depth filter.
 * The evaluator is built once per tenant and reused; a runtime SecurityModel change calls Invalidate
 * to drop the cached evaluator so the next request re-reads the store — live, without a restart.
 * `Invalidated` is raised after each Invalidate so per-principal caches built on the evaluator drop too.
 */
export class TenantReadAuthorization implements IReadFilterSource, IFieldReadMaskSource, ISecurityModelReload
{
    public readonly Invalidated: ISignal<string>

    private readonly securities = new Map<string, Promise<TenantSecurity>>()
    private readonly invalidated = new SecurityModelInvalidated()

    constructor(private readonly store: ITenantConfigStore)
    {
        this.Invalidated = this.invalidated
    }

    public async ReadFilterFor(context: AccessContext): Promise<IInstanceFilter>
    {
        const evaluator = await this.EvaluatorFor(context.Tenant.Id)
        return new AccessDepthInstanceFilter(evaluator, context.Principal, PrivilegeAction.Read)
    }

    public async HasSecurityModelFor(context: AccessContext): Promise<boolean>
    {
        return (await this.SecurityOf(context.Tenant.Id)).HasSecurityModel
    }

    public async WriteAuthorizerFor(context: AccessContext): Promise<IWriteAuthorizer>
    {
        const evaluator = await this.EvaluatorFor(context.Tenant.Id)
        return new AccessDepthWriteAuthorizer(evaluator, context.Principal)
    }

    public async WriteInstanceGateFor(context: AccessContext, target: IWriteTargetSource): Promise<IWriteInstanceGate>
    {
        const evaluator = await this.EvaluatorFor(context.Tenant.Id)
        return new AccessDepthWriteInstanceGate(evaluator, context.Principal, target)
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

/** No identity subsystem: the access-depth axis is inactive (keeps everything). */
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
