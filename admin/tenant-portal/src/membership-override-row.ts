import type { SecurityModelViewModel } from './security-model-view-model.js'
import type { MembershipOverrideDto } from './tenant-types.js'

// One per-principal membership override row, addressed by its index in the override list.
export class MembershipOverrideRow
{
    public constructor(
        private readonly override: MembershipOverrideDto,
        private readonly index: number,
        private readonly vm: SecurityModelViewModel)
    {
    }

    public get PrincipalId(): string
    {
        return this.override.principalId
    }

    public get HomeBusinessUnit(): string | undefined
    {
        return this.override.homeBusinessUnit
    }

    public get Teams(): readonly string[]
    {
        return this.override.teams ?? []
    }

    public SetPrincipal(principalId: string): void
    {
        this.vm.SetMembershipOverridePrincipal(this.index, principalId)
    }

    public SetHomeBusinessUnit(businessUnitId?: string): void
    {
        this.vm.SetMembershipOverrideHomeBusinessUnit(this.index, businessUnitId)
    }

    public ToggleTeam(teamId: string): void
    {
        this.vm.ToggleMembershipOverrideTeam(this.index, teamId)
    }

    public Remove(): void
    {
        this.vm.RemoveMembershipOverride(this.index)
    }
}
