import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { ActivityLog } from '../../activity-log.js'
import { EnvironmentRow } from '../../environment-row.js'
import { TenantApiError } from '../../tenant-api-client.js'
import type { EnvironmentDto, HiveHealthDto, HiveRolloutDto, ManifestDto } from '../../tenant-types.js'
import { AdminCapability } from '../../shell/admin-capability.js'
import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import { BestEffort } from '../environments/best-effort.js'
import { CreateEnvironmentDialogViewModel } from '../environments/create-environment-dialog-view-model.js'
import { EnvironmentPillViewModel } from '../environments/environment-pill-view-model.js'
import { VersionOffer } from '../environments/version-offer.js'
import { ActivityRows, type ActivityRowViewModel } from './activity-page-view-model.js'
import type { OverviewSectionService } from './overview-section-service.js'

// How the hive's link to Pragmatic reads on the Overview's connection card.
export enum OverviewConnectionState
{
    Connected,
    Quiet,
    NoHive,
    Forbidden,
    Unavailable,
}

// What the Overview reads about the hive: its connection, environment
// health, the published versions and the rollout. Every part is best-effort
// (a 401 still expires the session); without a hive there is none of it.
export class OverviewHiveSnapshot
{
    public constructor(
        public readonly Connection: OverviewConnectionState,
        public readonly Health: readonly HiveHealthDto[] = [],
        public readonly Manifests: readonly ManifestDto[] = [],
        public readonly Rollout: HiveRolloutDto | undefined = undefined)
    {
    }

    public static async Load(session: TenantSessionService): Promise<OverviewHiveSnapshot>
    {
        let hiveId: string | undefined
        try
        {
            hiveId = await session.ResolveHiveId()
        }
        catch (e)
        {
            return new OverviewHiveSnapshot(OverviewHiveSnapshot.ConnectionOf(e))
        }
        if (hiveId === undefined)
        {
            return new OverviewHiveSnapshot(OverviewConnectionState.NoHive)
        }
        const client = session.Client
        const [health, manifests, rollout] = await Promise.all([
            BestEffort.Or(client.GetHealth(hiveId), [] as HiveHealthDto[]),
            BestEffort.Or(client.ListManifests(), [] as ManifestDto[]),
            OverviewHiveSnapshot.ReadRollout(session, hiveId),
        ])
        return new OverviewHiveSnapshot(rollout[0], health, manifests, rollout[1])
    }

    private static async ReadRollout(session: TenantSessionService, hiveId: string): Promise<[OverviewConnectionState, HiveRolloutDto | undefined]>
    {
        try
        {
            return [OverviewConnectionState.Connected, await session.Client.GetRollout(hiveId)]
        }
        catch (e)
        {
            return [OverviewHiveSnapshot.ConnectionOf(e), undefined]
        }
    }

    // A failed read's connection state; a 401 propagates.
    private static ConnectionOf(e: unknown): OverviewConnectionState
    {
        BestEffort.RethrowUnauthorized(e)
        if (e instanceof TenantApiError && e.Status === TenantApiError.UnavailableStatus)
        {
            return OverviewConnectionState.Quiet
        }
        if (e instanceof TenantApiError && e.Status === TenantApiError.ForbiddenStatus)
        {
            return OverviewConnectionState.Forbidden
        }
        return OverviewConnectionState.Unavailable
    }
}

// One environment card: its name (opens its detail in Environments), status
// and health, the version it runs and its live address.
export class OverviewEnvironmentCardViewModel extends Observable
{
    private static readonly NotServingText = 'Not serving'

    private readonly openCommand: RelayCommand
    private readonly statusPill: EnvironmentPillViewModel
    private readonly healthPill: EnvironmentPillViewModel

    public constructor(private readonly row: EnvironmentRow, open: (name: string) => void)
    {
        super()
        this.openCommand = new RelayCommand(() => open(this.row.Name))
        this.statusPill = EnvironmentPillViewModel.Status(row)
        this.healthPill = EnvironmentPillViewModel.Health(row)
    }

    public get Name(): string
    {
        return this.row.Name
    }

    public get StatusPill(): EnvironmentPillViewModel
    {
        return this.statusPill
    }

    public get HealthPill(): EnvironmentPillViewModel
    {
        return this.healthPill
    }

    public get Version(): string
    {
        return this.row.Version
    }

    public get Template(): string
    {
        return this.row.Template
    }

    public get UrlText(): string
    {
        return this.row.Url ?? OverviewEnvironmentCardViewModel.NotServingText
    }

    public get OpenCommand(): RelayCommand
    {
        return this.openCommand
    }
}

// The Overview (home): everything running in the hive. Create environment;
// the newer-version offer (Review and adopt opens the adopt wizard in
// Releases); a card per environment (opens its detail in Environments); the
// latest activity; and the connection to Pragmatic. Only the environments
// list is essential: its failure is the page's Error. Health, versions, the
// rollout and the hive lookup only enrich the page and degrade.
export class OverviewPageViewModel extends TenantPageViewModel
{
    public static readonly RecentActivityCount = 5

    private static readonly CardsProperty = 'Cards'
    private static readonly RecentActivityProperty = 'RecentActivity'
    private static readonly HasRecentActivityProperty = 'HasRecentActivity'
    private static readonly HasNoRecentActivityProperty = 'HasNoRecentActivity'
    private static readonly SubtitleTemplate = 'Everything running in your hive, {hive}, for the {tenant} tenant.'
    private static readonly HiveToken = '{hive}'
    private static readonly TenantToken = '{tenant}'
    private static readonly VersionToken = '{version}'
    private static readonly BehindToken = '{behind}'
    private static readonly TotalToken = '{total}'
    private static readonly OfferTitleTemplate = 'Version {version} is available.'
    private static readonly OfferBodyTemplate = '{behind} of {total} environments are on an earlier version. Nothing changes until you choose to adopt.'
    private static readonly ConnectedLabel = 'Connected'
    private static readonly QuietLabel = 'Quiet'
    private static readonly ConnectedText = 'Pragmatic is reachable from your hive.'
    private static readonly QuietText = "Your hive can't reach Pragmatic right now. Your environments keep running."
    private static readonly NoHiveText = 'No hive yet. Your connection status appears once your hive is installed.'
    private static readonly ForbiddenText = 'Connection status is not available to you.'
    private static readonly UnavailableText = 'Could not load the connection status.'
    private static readonly DerivedProperties: readonly string[] = [
        'Subtitle', 'HasOffer', 'OfferTitle', 'OfferBody', 'ConnectionLabel', 'ConnectionText', 'IsConnected', 'IsQuiet', 'HasConnectionPill',
    ]

    private cards = new ObservableCollection<OverviewEnvironmentCardViewModel>()
    private recentActivity = new ObservableCollection<ActivityRowViewModel>()
    private environments: readonly EnvironmentDto[] = []
    private hive = new OverviewHiveSnapshot(OverviewConnectionState.Unavailable)
    private offer: ManifestDto | undefined
    private readonly createCommand: RelayCommand
    private readonly reviewAdoptCommand: RelayCommand
    private readonly seeAllActivityCommand: RelayCommand
    private readonly viewConnectionCommand: RelayCommand

    public constructor(session: TenantSessionService, private readonly section: OverviewSectionService)
    {
        super(session)
        this.createCommand = this.MutatingCommand(AdminCapability.Environments, () => this.Create())
        this.reviewAdoptCommand = this.MutatingCommand(AdminCapability.Adopt, async () => this.ReviewAdopt(), () => this.offer !== undefined)
        this.seeAllActivityCommand = new RelayCommand(() => this.section.OpenActivity())
        this.viewConnectionCommand = new RelayCommand(() => this.section.OpenConnection())
        // The section keeps one Overview page for the session, so this
        // subscription lives exactly as long as the log it watches.
        session.Activity.PropertyChanged(ActivityLog.EntriesProperty).subscribe(() => this.RebuildActivity())
        this.RebuildActivity()
    }

    // The header's Activity button (opens the session's Activity page).
    public get OpenActivityCommand(): RelayCommand
    {
        return this.section.OpenActivityCommand
    }

    public get Subtitle(): string
    {
        const O = OverviewPageViewModel
        return O.SubtitleTemplate.replace(O.HiveToken, this.Session.HiveLabel).replace(O.TenantToken, this.Session.TenantLabel)
    }

    public get CreateCommand(): RelayCommand
    {
        return this.createCommand
    }

    // The newer-version offer.
    public get HasOffer(): boolean
    {
        return this.offer !== undefined
    }

    public get OfferVersion(): string | undefined
    {
        return this.offer?.id
    }

    public get OfferTitle(): string
    {
        const O = OverviewPageViewModel
        return O.OfferTitleTemplate.replace(O.VersionToken, this.offer?.id ?? '')
    }

    public get OfferBody(): string
    {
        const O = OverviewPageViewModel
        const behind = this.offer === undefined ? 0 : VersionOffer.BehindCount(this.offer, this.hive.Rollout)
        const total = this.hive.Rollout?.environments.length ?? 0
        return O.OfferBodyTemplate.replace(O.BehindToken, String(behind)).replace(O.TotalToken, String(total))
    }

    public get ReviewAdoptCommand(): RelayCommand
    {
        return this.reviewAdoptCommand
    }

    // Why Review and adopt is disabled; '' when it is not.
    public get AdoptDeniedReason(): string
    {
        return this.Session.DeniedReason(AdminCapability.Adopt)
    }

    public get Cards(): ObservableCollection<OverviewEnvironmentCardViewModel>
    {
        return this.cards
    }

    // The latest RecentActivityCount observed events, newest first.
    public get RecentActivity(): ObservableCollection<ActivityRowViewModel>
    {
        return this.recentActivity
    }

    public get HasRecentActivity(): boolean
    {
        return this.recentActivity.Count > 0
    }

    public get HasNoRecentActivity(): boolean
    {
        return !this.HasRecentActivity
    }

    public get SeeAllActivityCommand(): RelayCommand
    {
        return this.seeAllActivityCommand
    }

    // The connection card.
    public get Connection(): OverviewConnectionState
    {
        return this.hive.Connection
    }

    public get IsConnected(): boolean
    {
        return this.hive.Connection === OverviewConnectionState.Connected
    }

    public get IsQuiet(): boolean
    {
        return this.hive.Connection === OverviewConnectionState.Quiet
    }

    public get HasConnectionPill(): boolean
    {
        return this.IsConnected || this.IsQuiet
    }

    public get ConnectionLabel(): string
    {
        const O = OverviewPageViewModel
        return this.IsQuiet ? O.QuietLabel : O.ConnectedLabel
    }

    public get ConnectionText(): string
    {
        const O = OverviewPageViewModel
        switch (this.hive.Connection)
        {
            case OverviewConnectionState.Connected:
                return O.ConnectedText
            case OverviewConnectionState.Quiet:
                return O.QuietText
            case OverviewConnectionState.NoHive:
                return O.NoHiveText
            case OverviewConnectionState.Forbidden:
                return O.ForbiddenText
            default:
                return O.UnavailableText
        }
    }

    public get ViewConnectionCommand(): RelayCommand
    {
        return this.viewConnectionCommand
    }

    // The names of the listed environments (the create dialog's duplicate check).
    public get EnvironmentNames(): readonly string[]
    {
        return this.environments.map(e => e.name)
    }

    protected override get PageCapability(): AdminCapability
    {
        return AdminCapability.Environments
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const [environments, hive] = await Promise.all([
            this.Session.Client.ListEnvironments(),
            OverviewHiveSnapshot.Load(this.Session),
        ])
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.Apply(environments, hive)
        return environments.length > 0
    }

    private Apply(environments: readonly EnvironmentDto[], hive: OverviewHiveSnapshot): void
    {
        const O = OverviewPageViewModel
        this.environments = environments
        this.hive = hive
        this.offer = VersionOffer.ForHive(hive.Manifests, hive.Rollout)
        const health = new Map(hive.Health.map(h => [h.environmentName, h]))
        const old = this.cards
        this.cards = new ObservableCollection<OverviewEnvironmentCardViewModel>()
        for (const env of environments)
        {
            this.cards.Add(new OverviewEnvironmentCardViewModel(new EnvironmentRow(env, health.get(env.name)), name => this.section.OpenEnvironment(name)))
        }
        this.RaisePropertyChanged(O.CardsProperty, old, this.cards)
        for (const property of O.DerivedProperties)
        {
            this.RaisePropertyChanged(property, undefined, (this as unknown as Record<string, unknown>)[property])
        }
        this.RaiseMutatingCommandsChanged()
    }

    private RebuildActivity(): void
    {
        const O = OverviewPageViewModel
        const old = this.recentActivity
        const had = this.HasRecentActivity
        this.recentActivity = ActivityRows.From(this.Session.Activity.Entries.slice(0, O.RecentActivityCount))
        this.RaisePropertyChanged(O.RecentActivityProperty, old, this.recentActivity)
        this.RaisePropertyChanged(O.HasRecentActivityProperty, had, this.HasRecentActivity)
        this.RaisePropertyChanged(O.HasNoRecentActivityProperty, !had, this.HasNoRecentActivity)
    }

    private ReviewAdopt(): void
    {
        if (this.offer !== undefined)
        {
            this.section.OpenAdopt(this.offer.id)
        }
    }

    // A created environment opens its detail in Environments; the Overview
    // reloads under it.
    private Create(): Promise<void>
    {
        return this.OpenCreate(this.section.Dialogs,
            dialogs => new CreateEnvironmentDialogViewModel(this.Session, dialogs, this.EnvironmentNames),
            CreateEnvironmentDialogViewModel.Title, async created =>
            {
                this.section.OpenEnvironment(created.name)
                await this.Refresh()
            })
    }
}
