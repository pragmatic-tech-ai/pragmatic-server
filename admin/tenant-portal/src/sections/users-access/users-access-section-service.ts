import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import type { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { TenantSectionService } from '../../shell/tenant-section-service.js'
import type { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TokenIssuedDto } from '../../tenant-types.js'
import { AccountDetailPageViewModel } from './account-detail-page-view-model.js'
import { TokenRevealPageViewModel } from './token-reveal-page-view-model.js'
import { UsersAccessPageViewModel } from './users-access-page-view-model.js'

// The Users & Access rail section: the tabbed page (Users, Roles &
// permissions, Tokens) over an environment, an account's detail, and the
// one-time reveal that follows issuing an API token.
export class UsersAccessSectionService extends TenantSectionService
{
    public static readonly Key = new ServiceKey<UsersAccessSectionService>('UsersAccessSectionService')

    private root: UsersAccessPageViewModel | undefined

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    // The section's root page; undefined before the section first shows.
    public get Root(): UsersAccessPageViewModel | undefined
    {
        return this.root
    }

    // Opens an account's detail (its grants, Grant role, Disable, Issue token).
    public OpenAccount(environment: string, principalId: string): void
    {
        this.Present(new AccountDetailPageViewModel(this.Session, this, environment, principalId))
    }

    // Shows a just-issued token's value once. The issued DTO is not kept;
    // only the reveal page holds the value.
    public RevealToken(environment: string, issued: TokenIssuedDto): void
    {
        this.Present(new TokenRevealPageViewModel(this, environment, issued.tokenRef, issued.principalId, issued.token))
    }

    // After the reveal is confirmed saved: back to the Users & Access page
    // (past an account detail the token was issued from), on its Tokens tab,
    // reloaded. Stops early under an older unconfirmed reveal: that one is
    // never dropped.
    public FinishTokenReveal(): void
    {
        let previous: Observable | undefined
        while (this.Current !== this.root && this.Current !== previous)
        {
            previous = this.Current
            this.Back()
        }
        if (this.Current === this.root)
        {
            void this.root?.ShowTokens()
        }
    }

    protected override CreateRoot(): TenantPageViewModel
    {
        this.root = new UsersAccessPageViewModel(this.Session, this)
        return this.root
    }
}
