import { ObservableCollection } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { EnvironmentRow } from '../../environment-row.js'
import { TenantApiError } from '../../tenant-api-client.js'
import type { HiveRolloutDto, RolloutEnvDto } from '../../tenant-types.js'
import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'

// One environment as the hive's rollout probe reports it.
export class ConnectionEnvironmentRowViewModel extends Observable
{
    private static readonly NoImage = 'no image reported'
    private static readonly HealthyLabel = 'Healthy'
    private static readonly DegradedLabel = 'Degraded'

    public constructor(private readonly env: RolloutEnvDto)
    {
        super()
    }

    public get Name(): string
    {
        return this.env.environmentName
    }

    public get Image(): string
    {
        return this.env.runningImage ?? ConnectionEnvironmentRowViewModel.NoImage
    }

    public get Version(): string
    {
        return EnvironmentRow.VersionOf(this.env.runningImage)
    }

    public get IsReady(): boolean
    {
        return this.env.ready
    }

    public get HealthLabel(): string
    {
        return this.env.ready ? ConnectionEnvironmentRowViewModel.HealthyLabel : ConnectionEnvironmentRowViewModel.DegradedLabel
    }
}

// Connection status: how the hive reaches Pragmatic. Read-only. The hive is
// the tenant's one hive; no hive is the Empty state. The rollout probe
// answering 503 means the link is quiet right now: that is a state of the
// connection (Populated, Quiet), not a failure of the page. 403 is Denied.
export class ConnectionPageViewModel extends TenantPageViewModel
{
    private static readonly IsQuietProperty = 'IsQuiet'
    private static readonly IsConnectedProperty = 'IsConnected'
    private static readonly StatusLabelProperty = 'StatusLabel'
    private static readonly HeadlineProperty = 'Headline'
    private static readonly TargetVersionTextProperty = 'TargetVersionText'
    private static readonly HiveLabelProperty = 'HiveLabel'
    private static readonly RowsProperty = 'Rows'
    private static readonly HasRowsProperty = 'HasRows'
    private static readonly HasNoRowsProperty = 'HasNoRows'
    private static readonly NoRowsTextProperty = 'NoRowsText'
    private static readonly ConnectedLabel = 'Connected'
    private static readonly QuietLabel = 'Quiet'
    private static readonly ConnectedHeadline = 'Pragmatic is reachable from your hive.'
    private static readonly QuietHeadline = "Your hive can't reach Pragmatic right now."
    private static readonly TargetTemplate = 'Target version: {version}'
    private static readonly VersionToken = '{version}'
    private static readonly NoTarget = 'No target version set yet.'
    private static readonly NoEnvironments = 'No environments reported yet.'
    private static readonly QuietNoEnvironments = 'Running versions are unavailable while the link is quiet.'

    private quiet = false
    private rollout: HiveRolloutDto | undefined
    private rows = new ObservableCollection<ConnectionEnvironmentRowViewModel>()

    public constructor(session: TenantSessionService)
    {
        super(session)
    }

    public get IsQuiet(): boolean
    {
        return this.quiet
    }

    public get IsConnected(): boolean
    {
        return !this.quiet
    }

    public get StatusLabel(): string
    {
        return this.quiet ? ConnectionPageViewModel.QuietLabel : ConnectionPageViewModel.ConnectedLabel
    }

    public get Headline(): string
    {
        return this.quiet ? ConnectionPageViewModel.QuietHeadline : ConnectionPageViewModel.ConnectedHeadline
    }

    public get HiveLabel(): string
    {
        return this.Session.HiveLabel
    }

    public get TargetVersionText(): string
    {
        const target = this.rollout?.targetVersion
        return target === undefined
            ? ConnectionPageViewModel.NoTarget
            : ConnectionPageViewModel.TargetTemplate.replace(ConnectionPageViewModel.VersionToken, target)
    }

    public get Rows(): ObservableCollection<ConnectionEnvironmentRowViewModel>
    {
        return this.rows
    }

    public get HasRows(): boolean
    {
        return this.rows.Count > 0
    }

    // Shown instead of the environments list when it is empty.
    public get NoRowsText(): string
    {
        return this.quiet ? ConnectionPageViewModel.QuietNoEnvironments : ConnectionPageViewModel.NoEnvironments
    }

    public get HasNoRows(): boolean
    {
        return !this.HasRows
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const hiveId = await this.Session.ResolveHiveId()
        if (hiveId === undefined)
        {
            return false
        }
        let rollout: HiveRolloutDto | undefined
        let quiet = false
        try
        {
            rollout = await this.Session.Client.GetRollout(hiveId)
        }
        catch (e)
        {
            if (!(e instanceof TenantApiError && e.Status === TenantApiError.UnavailableStatus))
            {
                throw e
            }
            quiet = true
        }
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.Apply(quiet, rollout)
        return true
    }

    private Apply(quiet: boolean, rollout: HiveRolloutDto | undefined): void
    {
        const P = ConnectionPageViewModel
        const before = [this.StatusLabel, this.Headline, this.TargetVersionText, this.HasRows, this.NoRowsText] as const
        const oldRows = this.rows
        const wasQuiet = this.quiet
        this.quiet = quiet
        this.rollout = rollout
        // A fresh collection each load: the list re-binds to it in one step.
        this.rows = new ObservableCollection<ConnectionEnvironmentRowViewModel>()
        for (const env of rollout?.environments ?? [])
        {
            this.rows.Add(new ConnectionEnvironmentRowViewModel(env))
        }
        this.RaisePropertyChanged(P.IsQuietProperty, wasQuiet, this.quiet)
        this.RaisePropertyChanged(P.IsConnectedProperty, !wasQuiet, this.IsConnected)
        this.RaisePropertyChanged(P.StatusLabelProperty, before[0], this.StatusLabel)
        this.RaisePropertyChanged(P.HeadlineProperty, before[1], this.Headline)
        this.RaisePropertyChanged(P.TargetVersionTextProperty, before[2], this.TargetVersionText)
        this.RaisePropertyChanged(P.RowsProperty, oldRows, this.rows)
        this.RaisePropertyChanged(P.HasRowsProperty, before[3], this.HasRows)
        this.RaisePropertyChanged(P.HasNoRowsProperty, !before[3], this.HasNoRows)
        this.RaisePropertyChanged(P.NoRowsTextProperty, before[4], this.NoRowsText)
        this.RaisePropertyChanged(P.HiveLabelProperty, undefined, this.HiveLabel)
    }
}
