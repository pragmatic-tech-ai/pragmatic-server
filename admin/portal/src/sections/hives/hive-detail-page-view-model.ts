import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { ApiError } from '../../api-client.js'
import { FleetConnection, FleetViewModel, type FleetRow } from '../../fleet-view-model.js'
import { PortalDates } from '../../portal-dates.js'
import type { EnvRolloutDto, FleetHiveDto, HiveDeleteOutcomeDto, HiveDto, HiveRolloutDto, LedgerDto, ObservationDto, PolicyDto } from '../../portal-types.js'
import { ObservedEnvironmentsViewModel } from '../../shell/observed-environments-view-model.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { FleetHiveRowViewModel } from '../fleet/fleet-page-view-model.js'
import { AgentInstallPhase, HiveAgentInstallViewModel } from './hive-agent-install-view-model.js'
import { HiveConsoleViewModel } from './hive-console-view-model.js'
import { HiveInstallMode, HiveInstallViewModel } from './hive-install-view-model.js'
import type { HivesSectionService } from './hives-section-service.js'

// A credential the hive references: its kind, its reference name and whether
// it is set. Never a secret value.
export class HiveCredentialViewModel extends Observable
{
    private static readonly NotSetLabel = 'Not set'
    private static readonly NoNameLabel = '-'
    private static readonly ReferencedLabel = 'Referenced by name'

    public constructor(public readonly Kind: string, private readonly reference: string | undefined)
    {
        super()
    }

    public get Name(): string
    {
        return this.reference ?? HiveCredentialViewModel.NoNameLabel
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

// The ledger actions the control plane records; values are the wire strings
// in LedgerDto.action.
export enum LedgerAction
{
    Gated = 'gated',
    Ungated = 'ungated',
    Withdrawn = 'withdrawn',
    Restored = 'restored',
    Selected = 'selected',
    Adopted = 'adopted',
}

// One version-history entry (the hive's adoption ledger).
export class HiveLedgerRowViewModel extends Observable
{
    // Typed as a Record over the enum, so the compiler rejects a LedgerAction
    // without a label. The Map view serves lookups by the wire string.
    private static readonly ActionLabelRecord: Record<LedgerAction, string> = {
        [LedgerAction.Gated]: 'Gated',
        [LedgerAction.Ungated]: 'Ungated',
        [LedgerAction.Withdrawn]: 'Withdrawn',
        [LedgerAction.Restored]: 'Restored',
        [LedgerAction.Selected]: 'Selected as target',
        [LedgerAction.Adopted]: 'Adopted',
    }

    private static readonly ActionLabels: ReadonlyMap<string, string> = new Map<string, string>(Object.entries(HiveLedgerRowViewModel.ActionLabelRecord))

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
        return HiveLedgerRowViewModel.LabelFor(this.entry.action)
    }

    // A ledger action's label; an action this portal does not know shows as sent.
    public static LabelFor(action: string): string
    {
        return HiveLedgerRowViewModel.ActionLabels.get(action) ?? action
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
// A Local hive (its bundle says autoInstall) offers Install agent, which the
// control plane runs itself, with the bundle, commands and Reissue token
// under Install manually; any other hive keeps the manual install only. The
// same Local hive offers its tenant console too (settings, install, Owner
// password), polled only while the page shows, like the agent install.
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
    private static readonly DeleteMessage = "The hive's agent is removed from its cluster (for a provisioned hive, its kind cluster is destroyed), its agent token is revoked, and the hive record is removed. The tenant-admin data volume and its seed Secret are kept. A hive that still reports environments cannot be deleted."
    private static readonly DeleteAnywayTitle = 'Delete the hive anyway?'
    private static readonly DeleteAnywayMessage = "Its agent could not be removed from the cluster. Deleting anyway revokes the agent's token and removes the hive record; the agent and its objects may remain in the cluster, locked out, until someone removes them there."
    private static readonly DestroyAnywayMessage = "Its kind cluster could not be destroyed. Deleting anyway revokes the agent's token and removes the hive record; the kind cluster may be left behind on this machine."
    private static readonly DeletedTemplate = 'Hive {id} was deleted.'
    private static readonly RetainedPrefix = ' Kept in the cluster with the tenant data: '
    private static readonly RetainedSeparator = ', '
    private static readonly SentenceEnd = '.'
    private static readonly NoticeSeparator = ' '
    private static readonly ForceableCodes: ReadonlySet<string> = new Set([ApiError.AgentUninstallFailedCode, ApiError.ClusterDestroyFailedCode])
    private static readonly DeleteAnywayLabel = 'Delete anyway'
    private static readonly CanDeleteAnywayProperty = 'CanDeleteAnyway'
    private static readonly DeleteAnywayTextProperty = 'DeleteAnywayText'
    private static readonly ReissueTitle = 'Reissue the agent token?'
    private static readonly ReissueMessage = 'A new one-time token replaces the current one at once. The running agent (and the tenant-admin pod, if installed) is locked out until the new token is in its Secret and they restart.'
    private static readonly ReissueLabel = 'Reissue'
    private static readonly NoToken = ''
    private static readonly DisplayNameProperty = 'DisplayName'
    private static readonly OwnerLabelProperty = 'OwnerLabel'
    private static readonly ClusterLabelProperty = 'ClusterLabel'
    private static readonly ConnectionLabelProperty = 'ConnectionLabel'
    private static readonly LastSeenLabelProperty = 'LastSeenLabel'
    private static readonly BannerTextProperty = 'BannerText'
    private static readonly HasBannerProperty = 'HasBanner'
    private static readonly TargetVersionLabelProperty = 'TargetVersionLabel'
    private static readonly ChannelsLabelProperty = 'ChannelsLabel'
    private static readonly MinVersionLabelProperty = 'MinVersionLabel'
    private static readonly HoldLabelProperty = 'HoldLabel'
    private static readonly ObservedProperty = 'Observed'
    private static readonly HasRolloutProperty = 'HasRollout'
    private static readonly HasNoRolloutProperty = 'HasNoRollout'
    private static readonly HasLedgerProperty = 'HasLedger'
    private static readonly HasNoLedgerProperty = 'HasNoLedger'
    private static readonly HasCheckInsProperty = 'HasCheckIns'
    private static readonly HasNoCheckInsProperty = 'HasNoCheckIns'
    private static readonly IsAutoInstallProperty = 'IsAutoInstall'
    private static readonly IsManualOnlyProperty = 'IsManualOnly'
    private static readonly ShowsManualProperty = 'ShowsManual'
    private static readonly ManualToggleLabelProperty = 'ManualToggleLabel'
    private static readonly ShowManualLabel = 'Install manually'
    private static readonly HideManualLabel = 'Hide manual install'

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
    private readonly deleteAnywayCommand: RelayCommand
    // The notice the hives list shows after this hive's delete.
    private deletedNotice = ''
    // Why the last delete could not finish its cluster work; '' until such a failure (offers delete anyway).
    private deleteAnywayText = ''
    // The code of that failure (which cluster work failed), for the delete anyway warning.
    private deleteAnywayCode = ''
    private readonly reissueTokenCommand: RelayCommand
    private readonly install: HiveInstallViewModel
    private readonly agentInstall: HiveAgentInstallViewModel
    private readonly console: HiveConsoleViewModel
    private readonly toggleManualCommand: RelayCommand
    private manualOpen = false
    // The install-path values as last raised, for their change notifications.
    private pathShown: InstallPathSnapshot

    public constructor(session: PortalSessionService, private readonly section: HivesSectionService, public readonly Id: string)
    {
        super(session)
        this.deleteCommand = this.MutatingCommand(() => this.Delete())
        this.deleteAnywayCommand = this.MutatingCommand(() => this.DeleteAnyway(), () => this.CanDeleteAnyway)
        // A reissue while an automatic install runs would revoke the token the install just stored.
        this.reissueTokenCommand = this.MutatingCommand(() => this.ReissueToken(), () => !this.agentInstall.IsInstalling)
        this.install = new HiveInstallViewModel(session, section, HiveInstallMode.FirstInstall)
        this.agentInstall = new HiveAgentInstallViewModel(session, Id, section.PollScheduler)
        this.console = new HiveConsoleViewModel(session, Id, section.PollScheduler)
        this.toggleManualCommand = new RelayCommand(() => this.ToggleManual())
        this.pathShown = this.PathSnapshot()
        this.install.PropertyChanged(HiveInstallViewModel.AutoInstallProperty).subscribe(() => this.RaisePathChanged())
        this.install.PropertyChanged(HiveInstallViewModel.HasLoadedProperty).subscribe(() => this.RaisePathChanged())
        this.agentInstall.PropertyChanged(HiveAgentInstallViewModel.InstallingProperty).subscribe(() => this.reissueTokenCommand.RaiseCanExecuteChanged())
        // Once a running install connects, reload: the home channel and check-ins now show the agent. Opening
        // the page on an install that already connected is not a transition, so it does not reload again.
        this.agentInstall.PropertyChanged(HiveAgentInstallViewModel.PhaseChangedProperty).subscribe(e =>
        {
            if (e.oldValue === AgentInstallPhase.Installing && e.newValue === AgentInstallPhase.Connected)
            {
                void this.Refresh()
            }
        })
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

    // True once a delete failed because the agent could not be removed from the hive's cluster.
    public get CanDeleteAnyway(): boolean
    {
        return this.deleteAnywayText.length > 0
    }

    // That failure's reason, shown beside Delete anyway.
    public get DeleteAnywayText(): string
    {
        return this.deleteAnywayText
    }

    // Deletes the hive without removing its agent from the cluster (confirmed by the hive id).
    public get DeleteAnywayCommand(): RelayCommand
    {
        return this.deleteAnywayCommand
    }

    // Mints a new one-time agent token (confirmed by the hive id) and reveals it with the rotation commands.
    public get ReissueTokenCommand(): RelayCommand
    {
        return this.reissueTokenCommand
    }

    // The agent's install bundle and the commands that apply it.
    public get Install(): HiveInstallViewModel
    {
        return this.install
    }

    // The automatic install (Install agent, its steps, error and Retry).
    public get AgentInstall(): HiveAgentInstallViewModel
    {
        return this.agentInstall
    }

    // The hive's tenant console: where it is served, its install and the Owner password.
    public get Console(): HiveConsoleViewModel
    {
        return this.console
    }

    // True when the control plane installs this hive's agent itself (Local hives).
    public get IsAutoInstall(): boolean
    {
        return this.install.AutoInstall
    }

    // True when the manual install is the only path (any other hive, or a
    // bundle that could not load); false until the bundle read settles, so a
    // Local hive never flashes the manual install.
    public get IsManualOnly(): boolean
    {
        return this.install.HasLoaded && !this.install.AutoInstall
    }

    // Whether the manual install (bundle, commands, Reissue token) shows: always
    // for a manual-only hive, behind Install manually for an automatic one.
    public get ShowsManual(): boolean
    {
        return this.IsManualOnly || this.manualOpen
    }

    // The Install manually expander's label.
    public get ManualToggleLabel(): string
    {
        return this.manualOpen ? HiveDetailPageViewModel.HideManualLabel : HiveDetailPageViewModel.ShowManualLabel
    }

    // Opens or closes the Install manually expander.
    public get ToggleManualCommand(): RelayCommand
    {
        return this.toggleManualCommand
    }

    // Shown: follow the hive's latest agent and console installs (polling while they run).
    protected override OnShown(): void
    {
        void this.agentInstall.Resume()
        void this.console.Resume()
    }

    // Left: stop polling (and forget a shown console Owner password).
    protected override OnHidden(): void
    {
        this.agentInstall.Stop()
        this.console.Stop()
    }

    private ToggleManual(): void
    {
        this.manualOpen = !this.manualOpen
        this.RaisePathChanged()
    }

    private PathSnapshot(): InstallPathSnapshot
    {
        return {
            IsAutoInstall: this.IsAutoInstall,
            IsManualOnly: this.IsManualOnly,
            ShowsManual: this.ShowsManual,
            ManualToggleLabel: this.ManualToggleLabel,
        }
    }

    // Raises whichever install-path values changed since last raised.
    private RaisePathChanged(): void
    {
        const C = HiveDetailPageViewModel
        const b = this.pathShown
        const now = this.PathSnapshot()
        this.pathShown = now
        this.RaiseIfChanged(C.IsAutoInstallProperty, b.IsAutoInstall, now.IsAutoInstall)
        this.RaiseIfChanged(C.IsManualOnlyProperty, b.IsManualOnly, now.IsManualOnly)
        this.RaiseIfChanged(C.ShowsManualProperty, b.ShowsManual, now.ShowsManual)
        this.RaiseIfChanged(C.ManualToggleLabelProperty, b.ManualToggleLabel, now.ManualToggleLabel)
    }

    private RaiseIfChanged<T>(name: string, old: T, now: T): void
    {
        if (old !== now)
        {
            this.RaisePropertyChanged(name, old, now)
        }
    }

    protected override async LoadCore(): Promise<boolean>
    {
        // A reload starts fresh: an earlier delete failure no longer stands for the hive as it is now.
        this.SetDeleteAnyway('', '')
        const generation = this.LoadGeneration
        const api = this.Session.Client
        void this.install.Load(this.Id)
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
        const before = this.Snapshot()
        this.fleetHive = fleetHive
        this.hive = hive
        this.row = fleetHive === undefined ? undefined : new FleetViewModel([fleetHive]).Rows[0]
        this.rollout = rollouts.find(r => r.hiveId === this.Id)
        this.policy = policies.find(p => p.hiveId === this.Id)
        this.observed = new ObservedEnvironmentsViewModel(fleetHive?.environments ?? [])
        this.FillCredentials(hive)
        if (hive !== undefined)
        {
            this.console.Load(hive)
        }
        this.Refill(this.rolloutRows, (this.rollout?.environments ?? []).map(e => new HiveRolloutRowViewModel(e)))
        this.Refill(this.ledgerRows, ledger.map(l => new HiveLedgerRowViewModel(l)))
        this.Refill(this.checkIns, observations.map(o => new HiveCheckInRowViewModel(o)))
        this.RaiseChangedSince(before)
        return true
    }

    // The bound values a load can change, captured before it applies.
    private Snapshot(): HiveDetailSnapshot
    {
        return {
            DisplayName: this.DisplayName,
            OwnerLabel: this.OwnerLabel,
            ClusterLabel: this.ClusterLabel,
            ConnectionLabel: this.ConnectionLabel,
            LastSeenLabel: this.LastSeenLabel,
            BannerText: this.BannerText,
            HasBanner: this.HasBanner,
            TargetVersionLabel: this.TargetVersionLabel,
            ChannelsLabel: this.ChannelsLabel,
            MinVersionLabel: this.MinVersionLabel,
            HoldLabel: this.HoldLabel,
            Observed: this.Observed,
            HasRollout: this.HasRollout,
            HasLedger: this.HasLedger,
            HasCheckIns: this.HasCheckIns,
        }
    }

    private RaiseChangedSince(b: HiveDetailSnapshot): void
    {
        const P = HiveDetailPageViewModel
        this.RaisePropertyChanged(P.DisplayNameProperty, b.DisplayName, this.DisplayName)
        this.RaisePropertyChanged(P.OwnerLabelProperty, b.OwnerLabel, this.OwnerLabel)
        this.RaisePropertyChanged(P.ClusterLabelProperty, b.ClusterLabel, this.ClusterLabel)
        this.RaisePropertyChanged(P.ConnectionLabelProperty, b.ConnectionLabel, this.ConnectionLabel)
        this.RaisePropertyChanged(P.LastSeenLabelProperty, b.LastSeenLabel, this.LastSeenLabel)
        this.RaisePropertyChanged(P.BannerTextProperty, b.BannerText, this.BannerText)
        this.RaisePropertyChanged(P.HasBannerProperty, b.HasBanner, this.HasBanner)
        this.RaisePropertyChanged(P.TargetVersionLabelProperty, b.TargetVersionLabel, this.TargetVersionLabel)
        this.RaisePropertyChanged(P.ChannelsLabelProperty, b.ChannelsLabel, this.ChannelsLabel)
        this.RaisePropertyChanged(P.MinVersionLabelProperty, b.MinVersionLabel, this.MinVersionLabel)
        this.RaisePropertyChanged(P.HoldLabelProperty, b.HoldLabel, this.HoldLabel)
        this.RaisePropertyChanged(P.ObservedProperty, b.Observed, this.Observed)
        this.RaisePropertyChanged(P.HasRolloutProperty, b.HasRollout, this.HasRollout)
        this.RaisePropertyChanged(P.HasNoRolloutProperty, !b.HasRollout, this.HasNoRollout)
        this.RaisePropertyChanged(P.HasLedgerProperty, b.HasLedger, this.HasLedger)
        this.RaisePropertyChanged(P.HasNoLedgerProperty, !b.HasLedger, this.HasNoLedger)
        this.RaisePropertyChanged(P.HasCheckInsProperty, b.HasCheckIns, this.HasCheckIns)
        this.RaisePropertyChanged(P.HasNoCheckInsProperty, !b.HasCheckIns, this.HasNoCheckIns)
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

    private ReissueToken(): Promise<void>
    {
        let token = HiveDetailPageViewModel.NoToken
        return this.ConfirmByName(this.section.Dialogs, {
            Expected: this.Id,
            Title: HiveDetailPageViewModel.ReissueTitle,
            Message: HiveDetailPageViewModel.ReissueMessage,
            ConfirmLabel: HiveDetailPageViewModel.ReissueLabel,
            Action: async () => { token = await this.Session.Client.ReissueAgentToken(this.Id) },
            OnConfirmed: async () => { this.section.ShowAgentTokenReveal(this.Id, token) },
        })
    }

    private Delete(): Promise<void>
    {
        return this.ConfirmByName(this.section.Dialogs, {
            Expected: this.Id,
            Title: HiveDetailPageViewModel.DeleteTitle,
            Message: HiveDetailPageViewModel.DeleteMessage,
            Action: () => this.DeleteOrOfferAnyway(),
            OnConfirmed: () => this.section.BackAfterDelete(this.deletedNotice),
        })
    }

    // Deletes; when the agent could not be removed from the cluster, offers delete anyway on the page, then rethrows
    // so the dialog shows the reason. A later success needs no offer.
    private async DeleteOrOfferAnyway(): Promise<void>
    {
        try
        {
            this.deletedNotice = this.DeletedNotice(await this.Session.Client.DeleteHive(this.Id))
        }
        catch (e)
        {
            if (e instanceof ApiError && e.Code !== undefined && HiveDetailPageViewModel.ForceableCodes.has(e.Code))
            {
                this.SetDeleteAnyway(e.message, e.Code)
            }
            else
            {
                this.SetDeleteAnyway('', '')
            }
            throw e
        }
    }

    // What the hives list says after the delete: the hive went, what was kept, and what may have been left.
    private DeletedNotice(outcome: HiveDeleteOutcomeDto): string
    {
        const C = HiveDetailPageViewModel
        let text = C.DeletedTemplate.replace(C.IdToken, this.Id)
        if (outcome.retained.length > 0)
        {
            text += C.RetainedPrefix + outcome.retained.join(C.RetainedSeparator) + C.SentenceEnd
        }
        if (outcome.notice !== undefined && outcome.notice.length > 0)
        {
            text += C.NoticeSeparator + outcome.notice
        }
        return text
    }

    private DeleteAnyway(): Promise<void>
    {
        return this.ConfirmByName(this.section.Dialogs, {
            Expected: this.Id,
            Title: HiveDetailPageViewModel.DeleteAnywayTitle,
            Message: this.deleteAnywayCode === ApiError.ClusterDestroyFailedCode ? HiveDetailPageViewModel.DestroyAnywayMessage : HiveDetailPageViewModel.DeleteAnywayMessage,
            ConfirmLabel: HiveDetailPageViewModel.DeleteAnywayLabel,
            Action: async () => { this.deletedNotice = this.DeletedNotice(await this.Session.Client.DeleteHive(this.Id, true)) },
            OnConfirmed: () => this.section.BackAfterDelete(this.deletedNotice),
        })
    }

    private SetDeleteAnyway(next: string, code: string): void
    {
        const C = HiveDetailPageViewModel
        this.deleteAnywayCode = code
        const was = [this.deleteAnywayText, this.CanDeleteAnyway] as const
        if (was[0] === next)
        {
            return
        }
        this.deleteAnywayText = next
        this.RaisePropertyChanged(C.DeleteAnywayTextProperty, was[0], next)
        this.RaisePropertyChanged(C.CanDeleteAnywayProperty, was[1], this.CanDeleteAnyway)
        this.deleteAnywayCommand.RaiseCanExecuteChanged()
    }
}

// The hive detail's install-path values, for their change notifications.
interface InstallPathSnapshot
{
    readonly IsAutoInstall: boolean
    readonly IsManualOnly: boolean
    readonly ShowsManual: boolean
    readonly ManualToggleLabel: string
}

// The hive detail's bound values before a load, for its change notifications.
interface HiveDetailSnapshot
{
    readonly DisplayName: string
    readonly OwnerLabel: string
    readonly ClusterLabel: string
    readonly ConnectionLabel: string
    readonly LastSeenLabel: string
    readonly BannerText: string
    readonly HasBanner: boolean
    readonly TargetVersionLabel: string
    readonly ChannelsLabel: string
    readonly MinVersionLabel: string
    readonly HoldLabel: string
    readonly Observed: ObservedEnvironmentsViewModel
    readonly HasRollout: boolean
    readonly HasLedger: boolean
    readonly HasCheckIns: boolean
}
