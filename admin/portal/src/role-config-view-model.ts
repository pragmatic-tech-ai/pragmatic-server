import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { PrivilegeDto, RoleConfigDto, RoleOverrideDto, SecurityModelDto } from './portal-types.js'

// Privilege actions the surface edits; values match the server wire strings.
export enum RoleAction
{
    Create = 'create',
    Read = 'read',
    Update = 'update',
    Delete = 'delete'
}

// Access levels; values match the server wire strings.
export enum RoleAccessLevel
{
    None = 'none',
    User = 'user',
    BusinessUnit = 'businessUnit',
    BusinessUnitAndChildren = 'businessUnitAndChildren',
    Organization = 'organization'
}

// The slice of ControlPlaneClient the view-model needs (a seam so tests need no live server).
export interface IRoleConfigSource
{
    GetSecurityModel(name: string): Promise<SecurityModelDto | null | undefined>
    SetSecurityModel(name: string, securityModel: SecurityModelDto): Promise<void>
}

// One editable row: a role's four CRUD levels for one concept.
export class RoleConceptRow
{
    public constructor(
        public readonly RoleId: string,
        public readonly Concept: string,
        public readonly Levels: Readonly<Record<RoleAction, RoleAccessLevel>>)
    {
    }
}

export class RoleConfigViewModel extends Observable
{
    public static readonly RowsProperty = 'Rows'
    public static readonly StatusProperty = 'Status'
    public static readonly SavedStatus = 'saved'
    public static readonly ErrorPrefix = 'error: '
    private static readonly Actions: readonly RoleAction[] = [RoleAction.Create, RoleAction.Read, RoleAction.Update, RoleAction.Delete]

    private model: SecurityModelDto = RoleConfigViewModel.EmptyModel()
    private rows: readonly RoleConceptRow[] = []
    private status = ''

    public constructor(private readonly source: IRoleConfigSource, private readonly environment: string)
    {
        super()
    }

    public get Rows(): readonly RoleConceptRow[]
    {
        return this.rows
    }

    public get Status(): string
    {
        return this.status
    }

    public get RoleIds(): string[]
    {
        return (this.model.roles ?? []).map(r => r.id)
    }

    // Overrides assign roles to principals; listed for display.
    public get Assignments(): readonly RoleOverrideDto[]
    {
        return this.model.roleAssignment?.overrides ?? []
    }

    // Loads the current model; null/undefined (none stored yet) starts from an empty editable model.
    public async Open(): Promise<void>
    {
        try
        {
            const loaded = await this.source.GetSecurityModel(this.environment)
            this.model = loaded === null || loaded === undefined ? RoleConfigViewModel.EmptyModel() : structuredClone(loaded)
            this.Rebuild()
            this.SetStatus('')
        }
        catch (e)
        {
            this.SetStatus(RoleConfigViewModel.ErrorPrefix + (e as Error).message)
        }
    }

    // Sets one CRUD level for a role/concept, adding the privilege when the role lacks it.
    public SetLevel(roleId: string, concept: string, action: RoleAction, level: RoleAccessLevel): void
    {
        const role = this.FindRole(roleId)
        if (role === undefined)
        {
            return
        }
        const existing = role.privileges.find(p => p.action === action && p.concept === concept)
        if (existing === undefined)
        {
            role.privileges.push({ action, concept, level })
        }
        else
        {
            existing.level = level
        }
        this.Rebuild()
    }

    // Ensures a role exists and has all four CRUD rows (at None) for the concept.
    public AddRoleConcept(roleId: string, roleName: string, concept: string): void
    {
        const roles = this.model.roles ?? (this.model.roles = [])
        let role = roles.find(r => r.id === roleId)
        if (role === undefined)
        {
            role = { id: roleId, name: roleName, privileges: [] }
            roles.push(role)
        }
        for (const action of RoleConfigViewModel.Actions)
        {
            if (!role.privileges.some(p => p.action === action && p.concept === concept))
            {
                role.privileges.push({ action, concept, level: RoleAccessLevel.None })
            }
        }
        this.Rebuild()
    }

    // Assigns a role to a principal via a roleAssignment override (idempotent).
    public AssignRole(principalId: string, roleId: string): void
    {
        const assignment = this.model.roleAssignment ?? (this.model.roleAssignment = { claimsMapping: [], overrides: [], teamRoles: [] })
        let override = assignment.overrides.find(o => o.principalId === principalId)
        if (override === undefined)
        {
            override = { principalId, roles: [] }
            assignment.overrides.push(override)
        }
        if (!override.roles.includes(roleId))
        {
            override.roles.push(roleId)
        }
        this.SetStatus('')
    }

    public async Save(): Promise<boolean>
    {
        try
        {
            await this.source.SetSecurityModel(this.environment, structuredClone(this.model))
            this.SetStatus(RoleConfigViewModel.SavedStatus)
            return true
        }
        catch (e)
        {
            this.SetStatus(RoleConfigViewModel.ErrorPrefix + (e as Error).message)
            return false
        }
    }

    private FindRole(roleId: string): RoleConfigDto | undefined
    {
        return (this.model.roles ?? []).find(r => r.id === roleId)
    }

    private Rebuild(): void
    {
        const next: RoleConceptRow[] = []
        for (const role of this.model.roles ?? [])
        {
            const byConcept = new Map<string, PrivilegeDto[]>()
            for (const p of role.privileges)
            {
                const list = byConcept.get(p.concept) ?? []
                list.push(p)
                byConcept.set(p.concept, list)
            }
            for (const [concept, privileges] of byConcept)
            {
                next.push(new RoleConceptRow(role.id, concept, RoleConfigViewModel.LevelsOf(privileges)))
            }
        }
        const old = this.rows
        this.rows = next
        this.RaisePropertyChanged(RoleConfigViewModel.RowsProperty, old, next)
    }

    private SetStatus(value: string): void
    {
        const old = this.status
        this.status = value
        this.RaisePropertyChanged(RoleConfigViewModel.StatusProperty, old, value)
    }

    private static LevelsOf(privileges: PrivilegeDto[]): Record<RoleAction, RoleAccessLevel>
    {
        const levels = {} as Record<RoleAction, RoleAccessLevel>
        for (const action of RoleConfigViewModel.Actions)
        {
            const found = privileges.find(p => p.action === action)
            levels[action] = (found?.level as RoleAccessLevel | undefined) ?? RoleAccessLevel.None
        }
        return levels
    }

    private static EmptyModel(): SecurityModelDto
    {
        return { businessUnits: [], teams: [], membership: { claimsMapping: [], overrides: [] }, ownershipRules: [] }
    }
}
