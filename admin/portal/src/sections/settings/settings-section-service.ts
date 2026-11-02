import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { PortalSectionService } from '../../shell/portal-section-service.js'
import type { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import { OperatorDetailPageViewModel } from './operator-detail-page-view-model.js'
import { OperatorPasswordRevealPageViewModel } from './operator-password-reveal-page-view-model.js'
import { SettingsPageViewModel } from './settings-page-view-model.js'

// The Settings rail section: the profile and the operator roster, then an
// operator's detail, then (after a reset) the one-time password reveal.
export class SettingsSectionService extends PortalSectionService
{
    public static readonly Key = new ServiceKey<SettingsSectionService>('SettingsSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    public OpenOperator(email: string): void
    {
        this.Present(new OperatorDetailPageViewModel(this.Session, this, email))
    }

    // Shows a reset password once, over the operator's detail; confirming
    // returns to the detail.
    public ShowResetPassword(email: string, password: string): void
    {
        this.Present(new OperatorPasswordRevealPageViewModel(this, email, password))
    }

    protected override CreateRoot(): PortalPageViewModel
    {
        return new SettingsPageViewModel(this.Session, this)
    }
}
