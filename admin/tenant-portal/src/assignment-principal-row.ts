import { AssignmentSide } from './assignment-side.js'
import type { SecurityModelViewModel } from './security-model-view-model.js'

// One principal (person) grant of the selected role/profile.
export class AssignmentPrincipalRow
{
    public constructor(
        private readonly side: AssignmentSide,
        private readonly principalId: string,
        private readonly vm: SecurityModelViewModel)
    {
    }

    public get PrincipalId(): string
    {
        return this.principalId
    }

    public Remove(): void
    {
        if (this.side === AssignmentSide.Role)
        {
            this.vm.RemoveRolePrincipalGrant(this.principalId)
        }
        else
        {
            this.vm.RemoveProfilePrincipalGrant(this.principalId)
        }
    }
}
