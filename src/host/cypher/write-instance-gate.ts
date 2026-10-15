import type { IInstanceView, IInstanceFilter } from '@pragmatic-tech-ai/todl'
import type { Principal, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { AccessDepthEvaluator } from '@pragmatic-tech-ai/todl-identity-engine'
import type { IWriteTargetSource } from '../write-target-source.js'

/** Per-record write authorizer: write-depth AND the Action.Write attribute predicate, deny-wins. */
export interface IWriteInstanceGate
{
    CreateDefaults(concept: string): readonly { field: string; value: string }[]
    Authorize(action: PrivilegeAction, view: IInstanceView): boolean
    AuthorizeById(action: PrivilegeAction, concept: string, id: string): Promise<boolean>
    Resolve(concept: string, id: string): Promise<IInstanceView | undefined>
    CanWriteField(concept: string, field: string, action: PrivilegeAction): boolean
}

/** Identity-configured gate: depth via the tenant evaluator, predicate via the request's Action.Write filter. */
export class AccessDepthWriteInstanceGate implements IWriteInstanceGate
{
    constructor(
        private readonly evaluator: AccessDepthEvaluator,
        private readonly principal: Principal,
        private readonly predicate: IInstanceFilter,
        private readonly target: IWriteTargetSource)
    {
    }

    public CreateDefaults(concept: string): readonly { field: string; value: string }[]
    {
        return this.evaluator.CreateDefaults(this.principal, concept)
    }

    public Authorize(action: PrivilegeAction, view: IInstanceView): boolean
    {
        return this.evaluator.Allows(this.principal, action, view) && this.predicate.Keep(view)
    }

    public async AuthorizeById(action: PrivilegeAction, concept: string, id: string): Promise<boolean>
    {
        const view = await this.target.Fetch(concept, id)
        return view !== undefined && this.Authorize(action, view)
    }

    public Resolve(concept: string, id: string): Promise<IInstanceView | undefined>
    {
        return this.target.Fetch(concept, id)
    }

    public CanWriteField(concept: string, field: string, action: PrivilegeAction): boolean
    {
        return this.evaluator.FieldSecurity().CanWriteField(this.principal, concept, field, action)
    }
}

/** No identity subsystem: every record passes, no stamping, no fetch. Preserves SP-3c(3). */
export class AllowAllWriteInstanceGate implements IWriteInstanceGate
{
    public static readonly Instance = new AllowAllWriteInstanceGate()

    public CreateDefaults(): readonly { field: string; value: string }[]
    {
        return []
    }

    public Authorize(): boolean
    {
        return true
    }

    public async AuthorizeById(): Promise<boolean>
    {
        return true
    }

    public async Resolve(): Promise<IInstanceView | undefined>
    {
        return undefined
    }
    public CanWriteField(): boolean
    {
        return true
    }
}
