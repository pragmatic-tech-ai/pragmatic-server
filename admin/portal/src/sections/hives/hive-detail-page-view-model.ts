import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { FleetConnection, FleetViewModel, type FleetRow } from '../../fleet-view-model.js'
import { PortalDates } from '../../portal-dates.js'
import type { EnvRolloutDto, FleetHiveDto, HiveDto, HiveRolloutDto, LedgerDto, ObservationDto, PolicyDto } from '../../portal-types.js'
import { NameConfirmDialogViewModel } from '../../shell/name-confirm-dialog-view-model.js'
import { ObservedEnvironmentsViewModel } from '../../shell/observed-environments-view-model.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { FleetHiveRowViewModel } from '../fleet/fleet-page-view-model.js'
import type { HivesSectionService } from './hives-section-service.js'

// A credential the hive references: its kind, its reference name and whether
// it is set. Never a secret value.
export class HiveCredentialViewModel extends Observable
{
    private static readonly NotSetLabel = 'Not set'
    private static readonly ReferencedLabel = 'Referenced by name'

    public constructor(public readonly Kind: string, private readonly reference: string | undefined)
    {
        super()
    }

    public get Name(): string
    {
        return this.reference ?? HiveCredentialViewModel.NotSetLabel
    }

    public get Status(): string
    {
        return this.reference === undefined ? HiveCredentialViewModel.NotSetLabel : HiveCredentialViewModel.ReferencedLabel
    }
}

// One environment's rollout state against the hive's target version.
export class HiveRolloutRowViewModel extends Observable
{
    private static readonly BehindLabel = 'Behind target'
    private static readonly NotReadyLabel = 'Not ready'
    private static readonly UpToDateLabel = 'Up to date'
    private static readonly NoImageLabel = '-'

    public constructor(private readonly env: EnvRolloutDto)
    {
        super()
    }

    public get Environment(): string
    {
        return this.env.environmentName
    }

    public get RunningImage(): string
    {
        return this.env.runningImage ?? HiveRolloutRowViewModel.NoImageLabel
    }

    public get StateLabel(): string
    {
        if (this.env.obsolete)
        {
            return HiveRolloutRowViewModel.BehindLabel
        }
        return this.env.ready ? HiveRolloutRowViewModel.UpToDateLabel : HiveRolloutRowViewModel.NotReadyLabel
    }
}

// One version-history entry (the hive's adoption ledger).
export class HiveLedgerRowViewModel extends Observable
{
    private static readonly ActionLabels: Readonly<Record<string, string>> = {
        gated: 'Gated',
        ungated: 'Ungated',
        withdrawn: 'Withdrawn',
        restored: 'Restored',
        selected: 'Selected as target',
        adopted: 'Adopted',
    }

    public constructor(private readonly entry: LedgerDto)
    {
        super()
    }

    public get WhenLabel(): string
    {
        return PortalDates.Label(this.entry.at)
    }

    public get ActionLabel(): string
    {
        return HiveLedgerRowViewModel.ActionLabels[this.entry.action] ?? this.entry.action
    }

    public get Version(): string
    {
        return this.entry.version
    }
}

// One past check-in: when, and how many environments were ready.
export class HiveCheckInRowViewModel extends Observable
{
    private static readonly SummaryTemplate = '{ready} of {total} ready'
    private static readonly ReadyToken = '{ready}'
    private static readonly TotalToken = '{total}'

    public constructor(private readonly observation: ObservationDto)
    {
        super()
    }

    public get WhenLabel(): string
    {
        return PortalDates.Label(this.observation.reportedAt)
    }

    public get SummaryLabel(): string
    {
        const ready = this.observation.environments.filter(e => e.ready).length
        return HiveCheckInRowViewModel.SummaryTemplate
            .replace(HiveCheckInRowViewModel.ReadyToken, String(ready))
            .replace(HiveCheckInRowViewModel.TotalToken, String(this.observation.environments.length))
    }
}

// A hive's detail: its home channel (read from its check-ins), credentials by
// name and status, rollout state, version history, per-hive release policy
// and the environments it observes, read-only. Delete asks for the hive id.
export class HiveDetailPageViewModel extends PortalPageViewModel
{
    private static readonly NotFoundTemplate = 'Hive {id} was not found.'
    private static readonly IdToken = '{id}'
    private static readonly NameToken = '{name}'
    private static readonly QuietTemplate = '{name} has not checked in for a while. Its last report stands. Pragmatic cannot connect in, so there is nothing to retry from here.'
    private static readonly AwaitingText = 'Awaiting first dial-in.'
    private static readonly ClusterSeparator = ' / '
    private static readonly RegistryCredentialKind = 'Registry credential'
    private static readonly TrustRootKind = 'Trust root'
    private static readonly ClusterConfigKind = 'Cluster config'
    private static readonly NoTargetLabel = 'No target selected'
    private static readonly InheritsTenantLabel = 'Inherits tenant'
    private static readonly NoHoldLabel = 'No per-hive hold'
    private static readonly HeldTemplate = 'Held: {name}'
    private static readonly ChannelSeparator = ', '
    private static readonly DeleteTitle = 'Delete this hive?'
    private static readonly DeleteMessage = 'The hive record is removed. A hive that still reports environments cannot be deleted.'
    private static readonly ChangedProperties = ['DisplayName', 'OwnerLabel', 'ClusterLabel', 'ConnectionLabel', 'LastSeenLabel',
        'BannerText', 'HasBanner', 'TargetVersionLabel', 'ChannelsLabel', 'MinVersionLabel', 'HoldLabel', 'Observed',
        'HasRollout', 'HasNoRollout', 'HasLedger', 'HasNoLedger', 'HasCheckIns', 'HasNoCheckIns']

    private fleetHive: FleetHiveDto | undefined
    private hive: HiveDto | undefined
    private row: FleetRow | undefined
    private rollout: HiveRolloutDto | undefined
    private policy: PolicyDto | undefined
    private observed = new ObservedEnvironmentsViewModel([])
    private readonly credentials = new ObservableCollection<HiveCredentialViewModel>()
    private readonly rolloutRows = new ObservableCollection<HiveRolloutRowViewModel>()
    private readonly ledgerRows = new ObservableCollection<HiveLedgerRowViewModel>()
    private readonly checkIns = new ObservableCollection<HiveCheckInRowViewModel>()
    private readonly deleteCommand: RelayCommand

    public constructor(session: PortalSessionService, private readonly section: HivesSectionService, public readonly Id: string)
    {
        super(session)
        this.deleteCommand = this.MutatingCommand(() => this.Delete())
    }

    public get DisplayName(): string
    {
        return this.fleetHive?.displayName ?? this.hive?.displayName ?? this.Id
    }

    public get OwnerLabel(): string
    {
        return this.row?.ownerLabel ?? ''
    }

    public get ClusterLabel(): string
    {
        const cluster = this.hive?.cluster
        if (cluster !== undefined)
        {
            return cluster.backend + HiveDetailPageViewModel.ClusterSeparator + cluster.mode
        }
        const fleet = this.fleetHive
        return fleet === undefined ? '' : fleet.clusterBackend + HiveDetailPageViewModel.ClusterSeparator + fleet.clusterMode
    }

    public get ConnectionLabel(): string
    {
        return FleetHiveRowViewModel.ConnectionText(this.row?.connection ?? FleetConnection.Awaiting)
    }

    public get LastSeenLabel(): string
    {
        return this.row?.lastSeenLabel ?? ''
    }

    // A notice for a quiet or not-yet-dialled hive; '' when connected.
    public get BannerText(): string
    {
        switch (this.row?.connection)
        {
            case FleetConnection.Quiet:
                return HiveDetailPageViewModel.QuietTemplate.replace(HiveDetailPageViewModel.NameToken, this.DisplayName)
            case FleetConnection.Awaiting:
                return HiveDetailPageViewModel.AwaitingText
            default:
                return ''
        }
    }

    public get HasBanner(): boolean
    {
        return this.BannerText.length > 0
    }

    public get Credentials(): ObservableCollection<HiveCredentialViewModel>
    {
        return this.credentials
    }

    public get TargetVersionLabel(): string
    {
        return this.rollout?.targetVersion ?? HiveDetailPageViewModel.NoTargetLabel
    }

    public get RolloutRows(): ObservableCollection<HiveRolloutRowViewModel>
    {
        return this.rolloutRows
    }

    public get HasRollout(): boolean
    {
        return this.rolloutRows.Count > 0
    }

    public get HasNoRollout(): boolean
    {
        return this.rolloutRows.Count === 0
    }

    public get LedgerRows(): ObservableCollection<HiveLedgerRowViewModel>
    {
        return this.ledgerRows
    }

    public get HasLedger(): boolean
    {
        return this.ledgerRows.Count > 0
    }

    public get HasNoLedger(): boolean
    {
        return this.ledgerRows.Count === 0
    }

    public get CheckIns(): ObservableCollection<HiveCheckInRowViewModel>
    {
        return this.checkIns
    }

    public get HasCheckIns(): boolean
    {
        return this.checkIns.Count > 0
    }

    public get HasNoCheckIns(): boolean
    {
        return this.checkIns.Count === 0
    }

    public get ChannelsLabel(): string
    {
        const channels = this.policy?.channels
        return channels !== undefined && channels.length > 0 ? channels.join(HiveDetailPageViewModel.ChannelSeparator) : HiveDetailPageViewModel.InheritsTenantLabel
    }

    public get MinVersionLabel(): string
    {
        return this.policy?.minVersion ?? HiveDetailPageViewModel.InheritsTenantLabel
    }

    public get HoldLabel(): string
    {
        const hold = this.policy?.hold
        return hold === undefined ? HiveDetailPageViewModel.NoHoldLabel : HiveDetailPageViewModel.HeldTemplate.replace(HiveDetailPageViewModel.NameToken, hold.reason)
    }

    // The observed environments panel: read-only, no commands.
    public get Observed(): ObservedEnvironmentsViewModel
    {
        return this.observed
    }

    public get BackCommand(): RelayCommand
    {
        return this.section.BackCommand
    }

    public get DeleteCommand(): RelayCommand
    {
        return this.deleteCommand
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const api = this.Session.Client
        const [fleet, hives, rollouts, policies, ledger, observations] = await Promise.all([
            api.ListFleet(), api.ListHives(), api.ListRollouts(), api.ListPolicies(),
            api.ListHiveLedger(this.Id), api.ListHiveObservations(this.Id),
        ])
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        const fleetHive = fleet.find(h => h.id === this.Id)
        const hive = hives.find(h => h.id === this.Id)
        if (fleetHive === undefined && hive === undefined)
        {
            throw new Error(HiveDetailPageViewModel.NotFoundTemplate.replace(HiveDetailPageViewModel.IdToken, this.Id))
        }
        const before = HiveDetailPageViewModel.ChangedProperties.map(p => this.ValueOf(p))
        this.fleetHive = fleetHive
        this.hive = hive
        this.row = fleetHive === undefined ? undefined : new FleetViewModel([fleetHive]).Rows[0]
        this.rollout = rollouts.find(r => r.hiveId === this.Id)
        this.policy = policies.find(p => p.hiveId === this.Id)
        this.observed = new ObservedEnvironmentsViewModel(fleetHive?.environments ?? [])
        this.FillCredentials(hive)
        this.Refill(this.rolloutRows, (this.rollout?.environments ?? []).map(e => new HiveRolloutRowViewModel(e)))
        this.Refill(this.ledgerRows, ledger.map(l => new HiveLedgerRowViewModel(l)))
        this.Refill(this.checkIns, observations.map(o => new HiveCheckInRowViewModel(o)))
        HiveDetailPageViewModel.ChangedProperties.forEach((p, i) => this.RaisePropertyChanged(p, before[i], this.ValueOf(p)))
        return true
    }

    private FillCredentials(hive: HiveDto | undefined): void
    {
        this.credentials.Clear()
        this.credentials.Add(new HiveCredentialViewModel(HiveDetailPageViewModel.RegistryCredentialKind, hive?.registry.credentialRef))
        this.credentials.Add(new HiveCredentialViewModel(HiveDetailPageViewModel.TrustRootKind, hive?.trustRootRef))
        this.credentials.Add(new HiveCredentialViewModel(HiveDetailPageViewModel.ClusterConfigKind, hive?.cluster.configRef))
    }

    private Refill<T>(target: ObservableCollection<T>, items: readonly T[]): void
    {
        target.Clear()
        for (const item of items)
        {
            target.Add(item)
        }
    }

    private ValueOf(property: string): unknown
    {
        return (this as unknown as Record<string, unknown>)[property]
    }

    private async Delete(): Promise<void>
    {
        const dialogs = this.section.Dialogs
        if (dialogs === undefined)
        {
            return
        }
        const api = this.Session.Client
        const confirm = new NameConfirmDialogViewModel(this.Session, dialogs, this.Id, HiveDetailPageViewModel.DeleteMessage,
            () => api.DeleteHive(this.Id))
        if (await confirm.Open(HiveDetailPageViewModel.DeleteTitle) === NameConfirmDialogViewModel.Confirmed)
        {
            await this.section.BackAndRefresh()
        }
    }
}
