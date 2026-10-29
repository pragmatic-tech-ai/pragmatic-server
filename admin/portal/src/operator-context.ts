import { ActInputs, ActVariant } from './kit/act.js'

// UI vocabulary for the signed-in operator's capability.
export enum OperatorRole
{
    Operator,
    Observer,
}

// PA-owned capability model. Maps the wire role (reported == enforced by the
// server) to what the UI may offer. Unknown or missing roles are Observer.
export class OperatorContext
{
    private static readonly FullWireRole = 'full'
    private static readonly OperatorLabel = 'Operator'
    private static readonly ObserverLabel = 'Observer'
    private static readonly NeededRole = 'Operator'
    private static readonly AskText = 'your operator lead'

    private readonly role: OperatorRole

    private constructor(role: OperatorRole)
    {
        this.role = role
    }

    public static FromWire(role: string): OperatorContext
    {
        return new OperatorContext(role === OperatorContext.FullWireRole ? OperatorRole.Operator : OperatorRole.Observer)
    }

    public get Role(): OperatorRole
    {
        return this.role
    }

    public get CanMutate(): boolean
    {
        return this.role === OperatorRole.Operator
    }

    public get RoleLabel(): string
    {
        return OperatorContext.RoleLabel(this.CanMutate ? OperatorContext.FullWireRole : '')
    }

    public static RoleLabel(wireRole: string): string
    {
        return wireRole === OperatorContext.FullWireRole ? OperatorContext.OperatorLabel : OperatorContext.ObserverLabel
    }

    public get NeededRoleLabel(): string
    {
        return OperatorContext.NeededRole
    }

    public get AskWhom(): string
    {
        return OperatorContext.AskText
    }

    public MutatingAct(label: string, onClick: () => void, variant?: ActVariant): ActInputs
    {
        return { can: this.CanMutate, label, onClick, variant, need: this.NeededRoleLabel, ask: this.AskWhom }
    }
}
