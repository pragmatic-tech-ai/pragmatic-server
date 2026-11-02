import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { FleetConnection, FleetViewModel, type FleetRow } from '../../fleet-view-model.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import type { FleetSectionService } from './fleet-section-service.js'

// One hives-table row: a bindable projection of a derived FleetRow.
export class FleetHiveRowViewModel extends Observable
{
    private static readonly ConnectedLabel = 'Connected'
    private static readonly QuietLabel = 'Quiet'
    private static readonly AwaitingLabel = 'Awaiting first check-in'
    private static readonly ReadyTemplate = '{ready} of {total} ready'
    private static readonly ReadyToken = '{ready}'
    private static readonly TotalToken = '{total}'

    private readonly openCommand: RelayCommand

    public constructor(private readonly row: FleetRow, open: RelayCommand)
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

    // Opens this hive's detail (the page's OpenCommand with this row).
    public get OpenCommand(): RelayCommand
    {
        return this.openCommand
    }

    public get ConnectionLabel(): string
    {
        return FleetHiveRowViewModel.ConnectionText(this.row.connection)
    }

    public get LastSeenLabel(): string
    {
        return this.row.lastSeenLabel
    }

    public get EnvironmentsLabel(): string
    {
        return FleetHiveRowViewModel.ReadyTemplate
            .replace(FleetHiveRowViewModel.ReadyToken, String(this.row.envCount - this.row.notReadyCount))
            .replace(FleetHiveRowViewModel.TotalToken, String(this.row.envCount))
    }

    public static ConnectionText(connection: FleetConnection): string
    {
        switch (connection)
        {
            case FleetConnection.Connected:
                return FleetHiveRowViewModel.ConnectedLabel
            case FleetConnection.Quiet:
                return FleetHiveRowViewModel.QuietLabel
            default:
                return FleetHiveRowViewModel.AwaitingLabel
        }
    }
}

// One Needs-attention entry: the hive and what is wrong with it.
export class FleetAttentionItemViewModel extends Observable
{
    private static readonly IssueSeparator = '; '

    public constructor(private readonly row: FleetRow)
    {
        super()
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

    public get IssuesText(): string
    {
        return this.row.issues.map(i => i.summary).join(FleetAttentionItemViewModel.IssueSeparator)
    }
}

// The Fleet home page: summary counts, the Needs-attention list (exceptions
// first) and the hives table, all derived from the last check-in of each hive.
export class FleetPageViewModel extends PortalPageViewModel
{
    private static readonly HiveCountProperty = 'HiveCount'
    private static readonly NeedAttentionCountProperty = 'NeedAttentionCount'
    private static readonly NotCheckingInCountProperty = 'NotCheckingInCount'
    private static readonly EnvironmentsObservedProperty = 'EnvironmentsObserved'
    private static readonly HasNeedsAttentionProperty = 'HasNeedsAttention'
    private static readonly HiveCountTextProperty = 'HiveCountText'
    private static readonly NeedAttentionCountTextProperty = 'NeedAttentionCountText'
    private static readonly NotCheckingInCountTextProperty = 'NotCheckingInCountText'
    private static readonly EnvironmentsObservedTextProperty = 'EnvironmentsObservedText'

    private fleet = new FleetViewModel([])
    private readonly rows = new ObservableCollection<FleetHiveRowViewModel>()
    private readonly needsAttention = new ObservableCollection<FleetAttentionItemViewModel>()
    private readonly openCommand: RelayCommand

    public constructor(session: PortalSessionService, private readonly section: FleetSectionService)
    {
        super(session)
        this.openCommand = new RelayCommand(row => this.Open(row))
    }

    // Opens a hive's detail in the Hives section; the parameter is the
    // FleetHiveRowViewModel.
    public get OpenCommand(): RelayCommand
    {
        return this.openCommand
    }

    public get Rows(): ObservableCollection<FleetHiveRowViewModel>
    {
        return this.rows
    }

    public get NeedsAttention(): ObservableCollection<FleetAttentionItemViewModel>
    {
        return this.needsAttention
    }

    public get HasNeedsAttention(): boolean
    {
        return this.fleet.NeedAttentionCount > 0
    }

    public get HiveCount(): number
    {
        return this.fleet.HiveCount
    }

    public get NeedAttentionCount(): number
    {
        return this.fleet.NeedAttentionCount
    }

    public get NotCheckingInCount(): number
    {
        return this.fleet.NotCheckingInCount
    }

    public get EnvironmentsObserved(): number
    {
        return this.fleet.EnvironmentsObserved
    }

    // String forms of the counts for the summary TextBlocks (Text is a string DP).
    public get HiveCountText(): string
    {
        return String(this.HiveCount)
    }

    public get NeedAttentionCountText(): string
    {
        return String(this.NeedAttentionCount)
    }

    public get NotCheckingInCountText(): string
    {
        return String(this.NotCheckingInCount)
    }

    public get EnvironmentsObservedText(): string
    {
        return String(this.EnvironmentsObserved)
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const dtos = await this.Session.Client.ListFleet()
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.Apply(new FleetViewModel(dtos))
        return dtos.length > 0
    }

    private Open(row: unknown): void
    {
        if (row instanceof FleetHiveRowViewModel)
        {
            this.section.OpenHive(row.Id)
        }
    }

    private Apply(next: FleetViewModel): void
    {
        const old = this.fleet
        this.fleet = next
        this.rows.Clear()
        for (const row of next.Rows)
        {
            this.rows.Add(new FleetHiveRowViewModel(row, this.openCommand))
        }
        this.needsAttention.Clear()
        for (const row of next.NeedsAttention)
        {
            this.needsAttention.Add(new FleetAttentionItemViewModel(row))
        }
        this.RaisePropertyChanged(FleetPageViewModel.HiveCountProperty, old.HiveCount, next.HiveCount)
        this.RaisePropertyChanged(FleetPageViewModel.NeedAttentionCountProperty, old.NeedAttentionCount, next.NeedAttentionCount)
        this.RaisePropertyChanged(FleetPageViewModel.NotCheckingInCountProperty, old.NotCheckingInCount, next.NotCheckingInCount)
        this.RaisePropertyChanged(FleetPageViewModel.EnvironmentsObservedProperty, old.EnvironmentsObserved, next.EnvironmentsObserved)
        this.RaisePropertyChanged(FleetPageViewModel.HiveCountTextProperty, String(old.HiveCount), this.HiveCountText)
        this.RaisePropertyChanged(FleetPageViewModel.NeedAttentionCountTextProperty, String(old.NeedAttentionCount), this.NeedAttentionCountText)
        this.RaisePropertyChanged(FleetPageViewModel.NotCheckingInCountTextProperty, String(old.NotCheckingInCount), this.NotCheckingInCountText)
        this.RaisePropertyChanged(FleetPageViewModel.EnvironmentsObservedTextProperty, String(old.EnvironmentsObserved), this.EnvironmentsObservedText)
        this.RaisePropertyChanged(FleetPageViewModel.HasNeedsAttentionProperty, old.NeedAttentionCount > 0, next.NeedAttentionCount > 0)
    }
}
