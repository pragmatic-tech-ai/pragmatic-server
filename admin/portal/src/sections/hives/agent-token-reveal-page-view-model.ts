import { OneTimeSecretPageViewModel } from '@pragmatic-tech-ai/pragmatic-app-shell'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { HiveInstallMode, HiveInstallViewModel } from './hive-install-view-model.js'
import type { HivesSectionService } from './hives-section-service.js'

// A reissued agent token, shown once (see OneTimeSecretPageViewModel), with
// the commands that put it in the hive's token Secret and restart the hive's
// deployments that read it. Confirming clears the token and returns to the
// hive's detail.
export class AgentTokenRevealPageViewModel extends OneTimeSecretPageViewModel
{
    private static readonly TitleText = 'Agent token reissued'
    private static readonly NoticeText = 'This token is shown once and the old one no longer works. Copy it now and pass it on over a secure channel. It cannot be shown again.'
    private static readonly ConfirmText = 'Back to the hive'

    private readonly install: HiveInstallViewModel

    public constructor(session: PortalSessionService, private readonly section: HivesSectionService, public readonly HiveId: string, value: string)
    {
        super(section, value)
        this.install = new HiveInstallViewModel(session, section, HiveInstallMode.Rotate)
        void this.install.Load(HiveId)
    }

    public get Title(): string
    {
        return AgentTokenRevealPageViewModel.TitleText
    }

    public get Notice(): string
    {
        return AgentTokenRevealPageViewModel.NoticeText
    }

    public get ConfirmLabel(): string
    {
        return AgentTokenRevealPageViewModel.ConfirmText
    }

    public get Install(): HiveInstallViewModel
    {
        return this.install
    }

    protected override OnSaved(): void
    {
        void this.section.BackAndRefresh()
    }
}
