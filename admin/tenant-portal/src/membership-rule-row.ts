import type { SecurityModelViewModel } from './security-model-view-model.js'
import type { MembershipClaimRuleDto } from './tenant-types.js'

// One claim-to-membership rule row, addressed by its index in the rule list.
export class MembershipRuleRow
{
    public constructor(
        private readonly rule: MembershipClaimRuleDto,
        private readonly index: number,
        private readonly vm: SecurityModelViewModel)
    {
    }

    public get Claim(): string
    {
        return this.rule.claim
    }

    public get Value(): string
    {
        return this.rule.value
    }

    public get HomeBusinessUnit(): string | undefined
    {
        return this.rule.homeBusinessUnit
    }

    public get Teams(): readonly string[]
    {
        return this.rule.teams ?? []
    }

    public SetClaim(claim: string): void
    {
        this.vm.SetMembershipRuleClaim(this.index, claim)
    }

    public SetValue(value: string): void
    {
        this.vm.SetMembershipRuleValue(this.index, value)
    }

    public SetHomeBusinessUnit(businessUnitId?: string): void
    {
        this.vm.SetMembershipRuleHomeBusinessUnit(this.index, businessUnitId)
    }

    public ToggleTeam(teamId: string): void
    {
        this.vm.ToggleMembershipRuleTeam(this.index, teamId)
    }

    public Remove(): void
    {
        this.vm.RemoveMembershipRule(this.index)
    }
}
