import { AssignmentSide } from './assignment-side.js'
import type { SecurityModelViewModel } from './security-model-view-model.js'

// One team grant of the selected role/profile; the name is resolved from the org structure at build time.
export class AssignmentTeamRow
{
    public constructor(
        private readonly side: AssignmentSide,
        private readonly teamId: string,
        private readonly teamName: string,
        private readonly vm: SecurityModelViewModel)
    {
    }

    public get TeamId(): string
    {
        return this.teamId
    }

    public get TeamName(): string
    {
        return this.teamName
    }

    public Remove(): void
    {
        if (this.side === AssignmentSide.Role)
        {
            this.vm.RemoveRoleTeamGrant(this.teamId)
        }
        else
        {
            this.vm.RemoveProfileTeamGrant(this.teamId)
        }
    }
}
