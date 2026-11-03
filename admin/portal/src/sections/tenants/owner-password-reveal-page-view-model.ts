import { OneTimeSecretPageViewModel } from '../../shell/one-time-secret-page-view-model.js'
import type { TenantsSectionService } from './tenants-section-service.js'

// Why an Owner password is being shown: the tenant was just created, or the
// operator reset it.
export enum OwnerPasswordKind
{
    Created,
    Reset,
}

// A tenant's Owner password, shown once (see OneTimeSecretPageViewModel).
// Confirming clears it: after creation it moves on to the tenant's detail;
// after a reset it returns to the detail it was opened from.
export class OwnerPasswordRevealPageViewModel extends OneTimeSecretPageViewModel
{
    private static readonly CreatedHeading = 'Tenant created'
    private static readonly ResetHeading = 'Owner password reset'
    private static readonly CreatedContinue = 'Continue to the tenant'
    private static readonly ResetContinue = 'Back to the tenant'

    public constructor(
        private readonly section: TenantsSectionService,
        public readonly TenantId: string,
        public readonly Email: string,
        value: string,
        public readonly Kind: OwnerPasswordKind = OwnerPasswordKind.Created)
    {
        super(section, value)
    }

    public get Heading(): string
    {
        return this.Kind === OwnerPasswordKind.Reset ? OwnerPasswordRevealPageViewModel.ResetHeading : OwnerPasswordRevealPageViewModel.CreatedHeading
    }

    public get ContinueLabel(): string
    {
        return this.Kind === OwnerPasswordKind.Reset ? OwnerPasswordRevealPageViewModel.ResetContinue : OwnerPasswordRevealPageViewModel.CreatedContinue
    }

    protected override OnSaved(): void
    {
        if (this.Kind === OwnerPasswordKind.Reset)
        {
            void this.section.BackAndRefresh()
            return
        }
        this.section.ShowTenantAfterReveal(this.TenantId)
    }
}
