import { OneTimeSecretPageViewModel } from '../../shell/one-time-secret-page-view-model.js'
import type { UsersAccessSectionService } from './users-access-section-service.js'

// A just-issued API token's value, shown once (see OneTimeSecretPageViewModel).
// Confirming clears it and returns to the Users & Access page's Tokens tab,
// which reloads. The token's reference, owner and environment are not secret.
export class TokenRevealPageViewModel extends OneTimeSecretPageViewModel
{
    public constructor(private readonly section: UsersAccessSectionService, private readonly environment: string,
        private readonly tokenRef: string, private readonly principalId: string, value: string)
    {
        super(section, value)
    }

    public get Environment(): string
    {
        return this.environment
    }

    public get TokenRef(): string
    {
        return this.tokenRef
    }

    public get PrincipalId(): string
    {
        return this.principalId
    }

    protected override OnSaved(): void
    {
        this.section.FinishTokenReveal()
    }
}
