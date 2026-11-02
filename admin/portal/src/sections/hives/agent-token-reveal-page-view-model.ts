import { OneTimeSecretPageViewModel } from '../../shell/one-time-secret-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { HiveInstallMode, HiveInstallViewModel } from './hive-install-view-model.js'
import type { HivesSectionService } from './hives-section-service.js'

// A reissued agent token, shown once (see OneTimeSecretPageViewModel), with
// the commands that put it in the hive's token Secret and restart the hive's
// deployments that read it. Confirming clears the token and returns to the
// hive's detail.
export class AgentTokenRevealPageViewModel extends OneTimeSecretPageViewModel
{
    private readonly install: HiveInstallViewModel

    public constructor(session: PortalSessionService, private readonly section: HivesSectionService, public readonly HiveId: string, value: string)
    {
        super(section, value)
        this.install = new HiveInstallViewModel(session, section, HiveInstallMode.Rotate)
        void this.install.Load(HiveId)
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
