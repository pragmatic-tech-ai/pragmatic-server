import { OneTimeSecretPageViewModel } from '@pragmatic-tech-ai/pragmatic-app-shell'
import type { SettingsSectionService } from './settings-section-service.js'

// An operator's new password after a reset, shown once (see
// OneTimeSecretPageViewModel). Confirming clears it and returns to the
// operator's detail.
export class OperatorPasswordRevealPageViewModel extends OneTimeSecretPageViewModel
{
    private static readonly TitleText = 'Password reset'
    private static readonly NoticeText = 'This password is shown once. Copy it now and hand it to the operator over a secure channel. It cannot be shown again.'
    private static readonly ConfirmText = 'Back to the operator'

    public constructor(private readonly section: SettingsSectionService, public readonly Email: string, value: string)
    {
        super(section, value)
    }

    public get Title(): string
    {
        return OperatorPasswordRevealPageViewModel.TitleText
    }

    public get Notice(): string
    {
        return OperatorPasswordRevealPageViewModel.NoticeText
    }

    public get ConfirmLabel(): string
    {
        return OperatorPasswordRevealPageViewModel.ConfirmText
    }

    protected override OnSaved(): void
    {
        void this.section.BackAndRefresh()
    }
}
