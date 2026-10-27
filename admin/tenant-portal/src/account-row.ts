import type { AccountDto, AdminSnapshotDto, GrantDto } from './tenant-types.js'

// One account line in the Users & Access list; built fresh on every snapshot load.
export class AccountRow
{
    private static readonly ActiveStatus = 'Active'
    private static readonly DisabledStatus = 'Disabled'
    private static readonly RoleSeparator = ', '

    public readonly Email: string
    public readonly PrincipalId: string
    public readonly Status: string
    public readonly RolesText: string
    public readonly Disabled: boolean

    public constructor(account: AccountDto, grants: GrantDto[])
    {
        this.Email = account.email
        this.PrincipalId = account.principalId
        this.Disabled = account.disabled
        this.Status = account.disabled ? AccountRow.DisabledStatus : AccountRow.ActiveStatus
        const roles = grants.filter(g => g.subject === account.principalId).map(g => g.role)
        this.RolesText = Array.from(new Set(roles)).join(AccountRow.RoleSeparator)
    }

    public static FromSnapshot(snapshot: AdminSnapshotDto): AccountRow[]
    {
        return snapshot.accounts.map(a => new AccountRow(a, snapshot.grants))
    }
}
