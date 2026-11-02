import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { HivesViewModel, type HiveListRow } from '../../hives-view-model.js'
import type { HiveDto } from '../../portal-types.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { FleetHiveRowViewModel } from '../fleet/fleet-page-view-model.js'
import type { HivesSectionService } from './hives-section-service.js'
import { NewHiveDialogViewModel } from './new-hive-dialog-view-model.js'

// One hives-table row. Its registry credential appears by reference name
// only; no secret value is ever on a hive row.
export class HiveRowViewModel extends Observable
{
    private static readonly HealthyLabel = 'Healthy'
    private static readonly NoReportLabel = 'No report yet'
    private static readonly NotReadyTemplate = '{n} not ready'
    private static readonly CountToken = '{n}'
    private static readonly NotSetLabel = 'Not set'

    private readonly openCommand: RelayCommand

    public constructor(private readonly row: HiveListRow, private readonly hive: HiveDto | undefined, open: RelayCommand)
    {
        super()
        this.openCommand = new RelayCommand(() => open.Execute(this))
    }

    public get Id(): string
    {
        return this.row.id
    }

    public get DisplayName(): string
    {
        return this.row.displayName
    }

    public get OwnerLabel(): string
    {
        return this.row.ownerLabel
    }

    public get ClusterLabel(): string
    {
        return this.row.cluster
    }

    public get ConnectionLabel(): string
    {
        return FleetHiveRowViewModel.ConnectionText(this.row.connection)
    }

    public get LastSeenLabel(): string
    {
        return this.row.lastSeenLabel
    }

    public get HealthLabel(): string
    {
        if (this.row.envCount === 0)
        {
            return HiveRowViewModel.NoReportLabel
        }
        if (this.row.notReadyCount === 0)
        {
            return HiveRowViewModel.HealthyLabel
        }
        return HiveRowViewModel.NotReadyTemplate.replace(HiveRowViewModel.CountToken, String(this.row.notReadyCount))
    }

    public get EnvCountText(): string
    {
        return String(this.row.envCount)
    }

    // The registry credential's reference name, never its value.
    public get CredentialLabel(): string
    {
        return this.hive?.registry.credentialRef ?? HiveRowViewModel.NotSetLabel
    }

    public get OpenCommand(): RelayCommand
    {
        return this.openCommand
    }
}

// The Hives list. New hive registers a hive record through a dialog; Stand up
// a hive (the provision wizard) arrives with Task 5 and is disabled until then.
export class HivesPageViewModel extends PortalPageViewModel
{
    private static readonly NewHiveTitle = 'Create hive'
    private static readonly StandUpAvailable = false

    private readonly rows = new ObservableCollection<HiveRowViewModel>()
    private readonly openCommand: RelayCommand
    private readonly newCommand: RelayCommand
    private readonly standUpCommand: RelayCommand

    public constructor(session: PortalSessionService, private readonly section: HivesSectionService)
    {
        super(session)
        this.openCommand = new RelayCommand(row => this.Open(row))
        this.newCommand = this.MutatingCommand(() => this.CreateHive())
        this.standUpCommand = this.MutatingCommand(() => Promise.resolve(), () => HivesPageViewModel.StandUpAvailable)
    }

    public get Rows(): ObservableCollection<HiveRowViewModel>
    {
        return this.rows
    }

    // Opens a row's hive detail; the parameter is the HiveRowViewModel.
    public get OpenCommand(): RelayCommand
    {
        return this.openCommand
    }

    public get NewCommand(): RelayCommand
    {
        return this.newCommand
    }

    public get StandUpCommand(): RelayCommand
    {
        return this.standUpCommand
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const api = this.Session.Client
        const [fleet, hives] = await Promise.all([api.ListFleet(), api.ListHives()])
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.rows.Clear()
        for (const row of new HivesViewModel(fleet).Rows)
        {
            this.rows.Add(new HiveRowViewModel(row, hives.find(h => h.id === row.id), this.openCommand))
        }
        return this.rows.Count > 0
    }

    private Open(row: unknown): void
    {
        if (row instanceof HiveRowViewModel)
        {
            this.section.OpenHive(row.Id)
        }
    }

    private async CreateHive(): Promise<void>
    {
        const dialogs = this.section.Dialogs
        if (dialogs === undefined)
        {
            return
        }
        const dialog = new NewHiveDialogViewModel(this.Session, dialogs)
        await dialog.Load()
        const created = await dialog.Open(HivesPageViewModel.NewHiveTitle)
        if (created !== undefined)
        {
            await this.Refresh()
        }
    }
}
