import type { SecurityModelViewModel } from './security-model-view-model.js'
import type { TeamDto } from './tenant-types.js'

// One team row. Holds a LIVE reference to the draft's DTO and is rebuilt fresh on every
// Refresh(), so reads stay current; edits go through the view-model.
export class TeamRow
{
    public constructor(
        private readonly team: TeamDto,
        private readonly vm: SecurityModelViewModel)
    {
    }

    public get Id(): string
    {
        return this.team.id
    }

    public get Name(): string
    {
        return this.team.name
    }

    public get OwningBusinessUnit(): string | undefined
    {
        return this.team.owningBusinessUnit
    }

    public Rename(name: string): void
    {
        this.vm.RenameTeam(this.team.id, name)
    }

    public SetOwningBusinessUnit(businessUnitId?: string): void
    {
        this.vm.SetTeamOwningBusinessUnit(this.team.id, businessUnitId)
    }

    public Remove(): void
    {
        this.vm.RemoveTeam(this.team.id)
    }
}
