import type { SecurityCatalogDto, SecurityModelDto } from '../../../tenant-types.js'
import { SecurityAssignments } from './security-assignments.js'
import { SecurityModelOrg } from './security-model-org.js'
import { SecurityOverrides } from './security-overrides.js'

export * from './security-model-enums.js'

// The editable environment security setting (C5) over the environment's
// catalog. Owns a deep clone of the loaded setting holding exactly the seven
// C5 sections (any retired section is dropped on load); the org, assignment
// and override sections edit that clone in place. ToDto() emits another deep
// clone, so the input is never mutated. Defaults come from the catalog; rows
// the catalog does not know are kept untouched.
export class SecurityModelDraft
{
    private readonly model: SecurityModelDto
    private readonly org: SecurityModelOrg
    private readonly assignments: SecurityAssignments
    private readonly overrides: SecurityOverrides

    public constructor(model: SecurityModelDto, public readonly Catalog: SecurityCatalogDto)
    {
        this.model = SecurityModelDraft.Sections(model)
        this.org = new SecurityModelOrg(this.model)
        this.assignments = new SecurityAssignments(this.model)
        this.overrides = new SecurityOverrides(this.model, Catalog)
    }

    // The setting of an environment that has none stored yet.
    public static EmptyModel(): SecurityModelDto
    {
        return { businessUnits: [], users: [], teams: [], roleAssignments: [], profileAssignments: [], roleOverrides: [], profileOverrides: [] }
    }

    public get Org(): SecurityModelOrg
    {
        return this.org
    }

    public get Assignments(): SecurityAssignments
    {
        return this.assignments
    }

    public get Overrides(): SecurityOverrides
    {
        return this.overrides
    }

    public get Dirty(): boolean
    {
        return this.org.Dirty || this.assignments.Dirty || this.overrides.Dirty
    }

    // The seven C5 sections, deep-cloned; assignments with no holders dropped.
    public ToDto(): SecurityModelDto
    {
        const out = SecurityModelDraft.Sections(this.model)
        out.roleAssignments = out.roleAssignments.filter(a => SecurityAssignments.HasHolders(a))
        out.profileAssignments = out.profileAssignments.filter(a => SecurityAssignments.HasHolders(a))
        return out
    }

    // A deep clone holding exactly the seven C5 sections (a missing one is empty).
    private static Sections(model: SecurityModelDto): SecurityModelDto
    {
        const copy = structuredClone(model)
        return {
            businessUnits: copy.businessUnits ?? [],
            users: copy.users ?? [],
            teams: copy.teams ?? [],
            roleAssignments: copy.roleAssignments ?? [],
            profileAssignments: copy.profileAssignments ?? [],
            roleOverrides: copy.roleOverrides ?? [],
            profileOverrides: copy.profileOverrides ?? [],
        }
    }
}
