import { OneTimeSecretPageViewModel } from '../../shell/one-time-secret-page-view-model.js'
import type { SettingsSectionService } from './settings-section-service.js'

// An operator's new password after a reset, shown once (see
// OneTimeSecretPageViewModel). Confirming clears it and returns to the
// operator's detail.
export class OperatorPasswordRevealPageViewModel extends OneTimeSecretPageViewModel
{
    public constructor(private readonly section: SettingsSectionService, public readonly Email: string, value: string)
    {
        super(section, value)
    }

    protected override OnSaved(): void
    {
        void this.section.BackAndRefresh()
    }
}
