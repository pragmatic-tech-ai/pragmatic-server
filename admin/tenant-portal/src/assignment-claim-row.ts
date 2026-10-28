import { AssignmentSide } from './assignment-side.js'
import type { SecurityModelViewModel } from './security-model-view-model.js'

// One claim-grant row of the selected role/profile, addressed by its index in the claim rule list.
// Rebuilt fresh on every Refresh(); edits delegate to the view-model for its side.
export class AssignmentClaimRow
{
    public constructor(
        private readonly side: AssignmentSide,
        private readonly index: number,
        private readonly claim: string,
        private readonly value: string,
        private readonly vm: SecurityModelViewModel)
    {
    }

    public get Claim(): string
    {
        return this.claim
    }

    public get Value(): string
    {
        return this.value
    }

    public SetClaim(claim: string): void
    {
        if (this.side === AssignmentSide.Role)
        {
            this.vm.SetRoleClaimGrantClaim(this.index, claim)
        }
        else
        {
            this.vm.SetProfileClaimGrantClaim(this.index, claim)
        }
    }

    public SetValue(value: string): void
    {
        if (this.side === AssignmentSide.Role)
        {
            this.vm.SetRoleClaimGrantValue(this.index, value)
        }
        else
        {
            this.vm.SetProfileClaimGrantValue(this.index, value)
        }
    }

    public Remove(): void
    {
        if (this.side === AssignmentSide.Role)
        {
            this.vm.RemoveRoleClaimGrant(this.index)
        }
        else
        {
            this.vm.RemoveProfileClaimGrant(this.index)
        }
    }
}
