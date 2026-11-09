import { AccessDefault, And, ConceptIs, FalsePredicate, MemberKind, NodeEvaluator, Not, Or, TruePredicate, ValueType } from '@pragmatic-tech-ai/graph'
import type { AccessScope, CellValue, IDefinitionDescription, ISchemaDescription, MemberInput, Predicate } from '@pragmatic-tech-ai/graph'
import { AccessContext, AccessLevel, DelegationDepth, Grant, IdentityConfig, OwnershipSourceKind, Principal, PrincipalKind, PrivilegeAction, ResourceAuthorizationPolicy, ResourceKind, ResourceRef, Role, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import type { IFieldSecurityConfig, IPrivilegeConfig, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { InMemoryTenantConfigStore } from '@pragmatic-tech-ai/todl-identity-host'
import { TenantReadAuthorization } from '../../cypher/read-filter-source.js'
import { EngineSchemaCatalog } from '../engine-schema-catalog.js'

/** Which rule of a scope a check reads. */
export enum ScopeAxis
{
    Read = 'Read',
    Create = 'Create',
    Update = 'Update',
    Delete = 'Delete',
}

/**
 * A tenant security model over acme.Widget / acme.Gizmo (a Widget subconcept) / acme.Gadget, a business-unit tree
 * root > sales > east > east1 and root > north, team-a (owned by north) and team-b (no unit). p1 lives in sales and
 * is in team-a; p2 lives in sales with no team. Every privilege goes to p1 through one role.
 */
export class DevScopeFx
{
    public static readonly TenantId = 't1'
    public static readonly P1 = 'p1'
    public static readonly P2 = 'p2'
    public static readonly TeamA = 'team-a'
    public static readonly TeamB = 'team-b'
    public static readonly Root = 'root'
    public static readonly Sales = 'sales'
    public static readonly East = 'east'
    public static readonly East1 = 'east1'
    public static readonly North = 'north'
    public static readonly Widget = 'acme.Widget'
    public static readonly Gizmo = 'acme.Gizmo'
    public static readonly Gadget = 'acme.Gadget'
    /** A Gizmo subconcept (Widget > Gizmo > Gear). */
    public static readonly Gear = 'acme.Gear'
    /** Its owner field is an Int64 in the engine schema. */
    public static readonly Counter = 'acme.Counter'
    public static readonly Element = 'todl.Element'
    public static readonly Term = 'todl.Term'
    public static readonly Owner = 'owner'
    public static readonly OwningBu = 'owningBu'
    public static readonly Secret = 'secret'
    public static readonly Code = 'code'
    public static readonly Role = 'role'
    public static readonly Profile = 'profile'
    private static readonly PackId = 'local'

    public static Model(privileges: readonly IPrivilegeConfig[], fieldSecurity?: IFieldSecurityConfig, gizmoOwnership = true): ISecurityModelConfig
    {
        const fromField = (value: string): { kind: OwnershipSourceKind; value: string } => ({ kind: OwnershipSourceKind.FromField, value })
        return {
            businessUnits: [
                { id: DevScopeFx.Root, name: 'Root' },
                { id: DevScopeFx.Sales, name: 'Sales', parent: DevScopeFx.Root },
                { id: DevScopeFx.East, name: 'East', parent: DevScopeFx.Sales },
                { id: DevScopeFx.East1, name: 'East 1', parent: DevScopeFx.East },
                { id: DevScopeFx.North, name: 'North', parent: DevScopeFx.Root },
            ],
            teams: [{ id: DevScopeFx.TeamA, name: 'A', owningBusinessUnit: DevScopeFx.North }, { id: DevScopeFx.TeamB, name: 'B' }],
            membership: { claimsMapping: [], overrides: [
                { principalId: DevScopeFx.P1, homeBusinessUnit: DevScopeFx.Sales, teams: [DevScopeFx.TeamA] },
                { principalId: DevScopeFx.P2, homeBusinessUnit: DevScopeFx.Sales, teams: [] },
            ] },
            ownershipRules: [
                { concept: DevScopeFx.Widget, owner: fromField(DevScopeFx.Owner), owningBusinessUnit: fromField(DevScopeFx.OwningBu) },
                ...(gizmoOwnership ? [{ concept: DevScopeFx.Gizmo, owner: fromField(DevScopeFx.Owner), owningBusinessUnit: fromField(DevScopeFx.OwningBu) }] : []),
                { concept: DevScopeFx.Gadget, owningBusinessUnit: { kind: OwnershipSourceKind.Fixed, value: DevScopeFx.North } },
                { concept: DevScopeFx.Gear, owner: fromField(DevScopeFx.Owner), owningBusinessUnit: fromField(DevScopeFx.OwningBu) },
                { concept: DevScopeFx.Counter, owner: fromField(DevScopeFx.Owner), owningBusinessUnit: fromField(DevScopeFx.OwningBu) },
            ],
            roles: [{ id: DevScopeFx.Role, name: 'Role', privileges: [...privileges] }],
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [{ principalId: DevScopeFx.P1, roles: [DevScopeFx.Role] }] },
            ...(fieldSecurity === undefined ? {} : { fieldSecurity }),
        }
    }

    public static Privilege(action: PrivilegeAction, level: AccessLevel, concept: string = DevScopeFx.Widget): IPrivilegeConfig
    {
        return { action, level, concept }
    }

    /** Field security: `secured` fields, and p1's profile granting `grants`. */
    public static Fields(secured: readonly string[], grants: readonly { field: string; read?: boolean; create?: boolean; update?: boolean }[], concept: string = DevScopeFx.Widget): IFieldSecurityConfig
    {
        return {
            securedFields: secured.map(field => ({ concept, field })),
            profiles: [{ id: DevScopeFx.Profile, name: 'Profile', grants: grants.map(grant => ({ concept, ...grant })) }],
            profileAssignment: { claimsMapping: [], teamProfiles: [], overrides: [{ principalId: DevScopeFx.P1, profiles: [DevScopeFx.Profile] }] },
        }
    }

    public static Context(principalId: string, claims: ReadonlyMap<string, string> = new Map(), groups: readonly string[] = []): AccessContext
    {
        const tenant = new Tenant(DevScopeFx.TenantId, TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal(principalId, DevScopeFx.TenantId, PrincipalKind.User, claims, groups)
        const grants = [new Grant(principalId, Role.Owner, new ResourceRef(ResourceKind.Tenant, DevScopeFx.TenantId, []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    /** A TenantReadAuthorization over a store holding `model` (none: the tenant has no security model). */
    public static async Authorization(model?: ISecurityModelConfig): Promise<{ Auth: TenantReadAuthorization; Store: InMemoryTenantConfigStore }>
    {
        const store = new InMemoryTenantConfigStore()
        if (model !== undefined) await DevScopeFx.Save(store, model)
        return { Auth: new TenantReadAuthorization(store), Store: store }
    }

    public static async Save(store: InMemoryTenantConfigStore, model: ISecurityModelConfig): Promise<void>
    {
        await store.Save(DevScopeFx.TenantId, new IdentityConfig(DevScopeFx.PackId, DelegationDepth.FullAuthz, new Map(), new Map(), new Map(), model))
    }

    /** The engine schema the describer would emit for the fixture concepts (hand-written, unit tests only). */
    public static Description(): ISchemaDescription
    {
        const definition = (name: string, parent: string | null, members: readonly MemberInput[]): IDefinitionDescription =>
            ({ Name: name, IsAspect: false, Parent: parent, Aspects: [], Members: members })
        const prop = (name: string): MemberInput => ({ Name: name, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true })
        return {
            Version: 'v1',
            Definitions: [
                definition(DevScopeFx.Element, null, [prop('label'), prop('class')]),
                definition(DevScopeFx.Term, DevScopeFx.Element, [prop('taxonomy')]),
                definition(DevScopeFx.Widget, DevScopeFx.Element, [prop(DevScopeFx.Owner), prop(DevScopeFx.OwningBu), prop(DevScopeFx.Secret), prop(DevScopeFx.Code)]),
                definition(DevScopeFx.Gizmo, DevScopeFx.Widget, []),
                definition(DevScopeFx.Gadget, DevScopeFx.Element, [prop(DevScopeFx.OwningBu)]),
                definition(DevScopeFx.Gear, DevScopeFx.Gizmo, []),
                definition(DevScopeFx.Counter, DevScopeFx.Element, [{ Name: DevScopeFx.Owner, Kind: MemberKind.Property, Type: ValueType.Int64, Nullable: true }, prop(DevScopeFx.OwningBu)]),
            ],
            Indexes: [],
            Seed: [],
            Bindings: [],
        }
    }

    /**
     * Whether `scope` admits a node of `concept` with `values` on `axis`, as the engine decides it: every applicable
     * entry (the concept's, its ancestors', its aspects') must hold; with none, the Default decides.
     */
    public static Admits(scope: AccessScope, concept: string, axis: ScopeAxis, values: Readonly<Record<string, CellValue>>, description: ISchemaDescription = DevScopeFx.Description()): boolean
    {
        const predicates: Predicate[] = []
        for (const key of new EngineSchemaCatalog(description).Applicable(concept))
        {
            const predicate = axis === ScopeAxis.Read ? scope.Rows.get(key) : scope.Writes.get(key)?.[axis]
            if (predicate !== undefined) predicates.push(predicate)
        }
        if (predicates.length === 0) return scope.Default === AccessDefault.Allow
        const cells = new Map<string, CellValue>(Object.entries(values))
        return predicates.every(predicate => NodeEvaluator.Matches(DevScopeFx.Specialize(predicate, concept), cells, 'n'))
    }

    /** `p` with every ConceptIs decided for a node of `concept` (the engine decides it from the node; NodeEvaluator reads values only). */
    public static Specialize(p: Predicate, concept: string): Predicate
    {
        if (p instanceof ConceptIs) return p.Concept === concept ? TruePredicate.Instance : FalsePredicate.Instance
        if (p instanceof Not) return new Not(DevScopeFx.Specialize(p.Term, concept))
        if (p instanceof And) return new And(p.Terms.map(term => DevScopeFx.Specialize(term, concept)))
        if (p instanceof Or) return new Or(p.Terms.map(term => DevScopeFx.Specialize(term, concept)))
        return p
    }
}
