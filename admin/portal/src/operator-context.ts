// UI vocabulary for the signed-in operator's capability.
export enum OperatorRole
{
    Operator,
    Observer,
}

// PA-owned capability model. Maps the operator's role (the session's app_roles
// claim, reported == enforced by the server; an operator record's wire role in
// the operators list) to what the UI may offer. Unknown or missing roles are
// Observer.
export class OperatorContext
{
    public static readonly FullWireRole = 'full'
    public static readonly ReadOnlyWireRole = 'readonly'
    // The console's application roles as the session's app_roles claim names them.
    public static readonly FullAppRole = 'operator.full'
    public static readonly ReadOnlyAppRole = 'operator.read-only'
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

    // The signed-in operator from the session's application roles: Operator only with operator.full.
    public static FromAppRoles(appRoles: readonly string[]): OperatorContext
    {
        return new OperatorContext(appRoles.includes(OperatorContext.FullAppRole) ? OperatorRole.Operator : OperatorRole.Observer)
    }

    // The session app role an operator record's wire role grants.
    public static AppRoleFor(wireRole: string): string
    {
        return wireRole === OperatorContext.FullWireRole ? OperatorContext.FullAppRole : OperatorContext.ReadOnlyAppRole
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
}
