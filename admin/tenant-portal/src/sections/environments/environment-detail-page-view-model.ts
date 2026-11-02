import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { ActivityLog } from '../../activity-log.js'
import { EnvironmentRow } from '../../environment-row.js'
import type { EnvironmentDto, HiveHealthDto, ManifestDto } from '../../tenant-types.js'
import { AdminCapability } from '../../shell/admin-capability.js'
import { ShownPage, type IShownPage } from '../../shell/shown-page.js'
import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import { ActivityRows, type ActivityRowViewModel } from '../overview/activity-page-view-model.js'
import { BestEffort } from './best-effort.js'
import { EnvironmentPillViewModel } from './environment-pill-view-model.js'
import type { EnvironmentsSectionService } from './environments-section-service.js'
import { VersionOffer } from './version-offer.js'

// The detail page's tabs, in order.
export enum EnvironmentDetailTab
{
    Application,
    Health,
    Access,
}

// One environment: its status and health, lifecycle commands (Start when
// stopped; Stop, with a confirm, and Restart when running; Delete, typing
// the name), and three tabs: Application & version (with the newer version
// offered, when there is one), Health & activity (this environment's
// observed events and its live logs) and Access (addresses).
//
// The log stream is open only while the logs panel is open AND the page is
// on screen: leaving the page (Back, another section) closes it, coming back
// reopens it. Pause stops appending without closing the stream. The buffer
// keeps the last MaxLogChars characters.
export class EnvironmentDetailPageViewModel extends TenantPageViewModel implements IShownPage
{
    public static readonly MaxLogChars = 100_000
    public static readonly ApplicationTabLabel = 'Application & version'
    public static readonly HealthTabLabel = 'Health & activity'
    public static readonly AccessTabLabel = 'Access'
    public static readonly DeleteConsequences: readonly string[] = [
        'The live URL stops serving immediately.',
        "The environment's database and files are deleted.",
        'This cannot be undone.',
    ]

    private static readonly NotFoundTemplate = 'Environment {name} no longer exists.'
    private static readonly NameToken = '{name}'
    private static readonly VersionToken = '{version}'
    private static readonly EnvironmentProperty = 'Environment'
    private static readonly SelectedTabProperty = 'SelectedTab'
    private static readonly IsApplicationTabProperty = 'IsApplicationTab'
    private static readonly IsHealthTabProperty = 'IsHealthTab'
    private static readonly IsAccessTabProperty = 'IsAccessTab'
    private static readonly ActivityRowsProperty = 'ActivityRows'
    private static readonly HasActivityProperty = 'HasActivity'
    private static readonly HasNoActivityProperty = 'HasNoActivity'
    private static readonly LogsOpenProperty = 'LogsOpen'
    private static readonly LogsToggleLabelProperty = 'LogsToggleLabel'
    private static readonly PausedProperty = 'Paused'
    private static readonly PauseLabelProperty = 'PauseLabel'
    private static readonly LogTextProperty = 'LogText'
    private static readonly SubSeparator = ' \u00b7 '
    private static readonly HostSeparator = '.'
    private static readonly BundleSeparator = ' '
    private static readonly NotServingText = 'Not serving'
    private static readonly NotFederatedText = 'Not federated'
    private static readonly NoUiBundleText = 'No UI bundle deployed yet'
    private static readonly SignedText = 'Signed by the platform trust root'
    private static readonly NotApplicableText = 'Not applicable'
    private static readonly NoHealthText = 'Health: unavailable'
    private static readonly HealthPrefix = 'Health: '
    private static readonly ReadyText = 'ready'
    private static readonly NotReadyText = 'not ready'
    private static readonly DetailSeparator = ' - '
    private static readonly NoLogsText = 'No logs yet (stream is live while the environment runs).'
    private static readonly ViewLogsLabel = 'View logs'
    private static readonly HideLogsLabel = 'Hide logs'
    private static readonly PauseText = 'Pause'
    private static readonly ResumeText = 'Resume'
    private static readonly OfferTitleTemplate = 'Version {version} is offered.'
    private static readonly NewestTemplate = '{name} is on the newest version offered to your hive.'
    private static readonly StopTitleTemplate = 'Stop {name}?'
    private static readonly StopMessageTemplate = '{name} stops serving until you start it again.'
    private static readonly StopConsequences: readonly string[] = [
        'The live URL stops serving until the environment is started again.',
        'Its data is kept.',
    ]
    private static readonly StopLabel = 'Stop environment'
    private static readonly DeleteTitleTemplate = 'Delete {name}?'
    private static readonly DeleteMessageTemplate = 'Deleting {name} removes it from your hive.'
    private static readonly DeleteLabel = 'Delete environment'
    // Everything that derives from the loaded environment and versions.
    private static readonly DerivedProperties: readonly string[] = [
        'StatusPill', 'HealthPill', 'IsRunning', 'IsStopped', 'IsFailed', 'IsUnknown', 'SubText', 'UrlText', 'Version', 'Type',
        'Template', 'EnvironmentId', 'Created', 'UiBundleText', 'SignatureText', 'Offer', 'HasOffer', 'HasNoOffer', 'OfferTitle',
        'OfferNotes', 'HealthText', 'SignInAddress',
    ]

    private readonly tabLabels = new ObservableCollection<string>()
    private environment: EnvironmentRow | undefined
    private statusPill: EnvironmentPillViewModel | undefined
    private healthPill: EnvironmentPillViewModel | undefined
    private manifests: readonly ManifestDto[] = []
    private tab = EnvironmentDetailTab.Application
    private activityRows = new ObservableCollection<ActivityRowViewModel>()
    private logsOpen = false
    private shown = false
    private paused = false
    private logBuffer = ''
    private closeStream: (() => void) | undefined
    private activitySubscription: IDisposable | undefined
    private readonly startCommand: RelayCommand
    private readonly stopCommand: RelayCommand
    private readonly restartCommand: RelayCommand
    private readonly deleteCommand: RelayCommand
    private readonly reviewAdoptCommand: RelayCommand
    private readonly toggleLogsCommand: RelayCommand
    private readonly togglePauseCommand: RelayCommand

    public constructor(session: TenantSessionService, private readonly section: EnvironmentsSectionService, private readonly name: string)
    {
        super(session)
        ShownPage.Register(this)
        const D = EnvironmentDetailPageViewModel
        this.tabLabels.Add(D.ApplicationTabLabel)
        this.tabLabels.Add(D.HealthTabLabel)
        this.tabLabels.Add(D.AccessTabLabel)
        const E = AdminCapability.Environments
        this.startCommand = this.MutatingCommand(E, () => this.Start(), () => this.IsStopped)
        this.stopCommand = this.MutatingCommand(E, () => this.Stop(), () => this.IsRunning)
        this.restartCommand = this.MutatingCommand(E, () => this.Restart(), () => this.IsRunning)
        this.deleteCommand = this.MutatingCommand(E, () => this.Delete(), () => this.environment !== undefined)
        this.reviewAdoptCommand = this.MutatingCommand(AdminCapability.Adopt, async () => this.ReviewAdopt(), () => this.HasOffer)
        this.toggleLogsCommand = new RelayCommand(() => this.ToggleLogs())
        this.togglePauseCommand = new RelayCommand(() => this.TogglePause())
    }

    public get Name(): string
    {
        return this.name
    }

    public get BackCommand(): RelayCommand
    {
        return this.section.BackCommand
    }

    public get StatusPill(): EnvironmentPillViewModel | undefined
    {
        return this.statusPill
    }

    public get HealthPill(): EnvironmentPillViewModel | undefined
    {
        return this.healthPill
    }

    public get IsRunning(): boolean
    {
        return this.environment?.IsRunning ?? false
    }

    public get IsStopped(): boolean
    {
        return this.environment?.IsStopped ?? false
    }

    public get IsFailed(): boolean
    {
        return this.environment?.IsFailed ?? false
    }

    public get IsUnknown(): boolean
    {
        return this.environment?.IsUnknown ?? false
    }

    // Template, type and environment id, under the name.
    public get SubText(): string
    {
        const env = this.environment?.Dto
        if (env === undefined)
        {
            return ''
        }
        const S = EnvironmentDetailPageViewModel.SubSeparator
        return env.template + S + env.type + S + env.environmentId
    }

    public get UrlText(): string
    {
        return this.environment?.Url ?? EnvironmentDetailPageViewModel.NotServingText
    }

    // Application & version.
    public get Version(): string
    {
        return this.environment?.Version ?? EnvironmentRow.VersionOf(undefined)
    }

    public get Type(): string
    {
        return this.environment?.Dto.type ?? ''
    }

    public get Template(): string
    {
        return this.environment?.Template ?? ''
    }

    public get EnvironmentId(): string
    {
        return this.environment?.EnvironmentId ?? ''
    }

    public get Created(): string
    {
        return this.environment?.Dto.createdAt ?? ''
    }

    public get UiBundleText(): string
    {
        const bundle = this.environment?.Dto.uiBundle
        const D = EnvironmentDetailPageViewModel
        return bundle === undefined ? D.NoUiBundleText : bundle.appName + D.BundleSeparator + bundle.appVersion
    }

    public get SignatureText(): string
    {
        const D = EnvironmentDetailPageViewModel
        return this.environment?.Dto.uiBundle === undefined ? D.NotApplicableText : D.SignedText
    }

    // The newer version offered to this environment, when there is one.
    public get Offer(): ManifestDto | undefined
    {
        return VersionOffer.ForEnvironment(this.manifests, this.environment?.RunningImage)
    }

    public get HasOffer(): boolean
    {
        return this.Offer !== undefined
    }

    public get HasNoOffer(): boolean
    {
        return !this.HasOffer
    }

    public get OfferTitle(): string
    {
        const D = EnvironmentDetailPageViewModel
        return D.OfferTitleTemplate.replace(D.VersionToken, this.Offer?.id ?? '')
    }

    public get OfferNotes(): string
    {
        return this.Offer?.notes ?? ''
    }

    public get NewestText(): string
    {
        const D = EnvironmentDetailPageViewModel
        return D.NewestTemplate.replace(D.NameToken, this.name)
    }

    // Why Review and adopt is disabled; '' when it is not.
    public get AdoptDeniedReason(): string
    {
        return this.Session.DeniedReason(AdminCapability.Adopt)
    }

    // Health & activity.
    public get HealthText(): string
    {
        const D = EnvironmentDetailPageViewModel
        const h: HiveHealthDto | undefined = this.environment?.Health
        if (h === undefined)
        {
            return D.NoHealthText
        }
        const state = h.ready ? D.ReadyText : D.NotReadyText
        return D.HealthPrefix + state + (h.detail.length === 0 ? '' : D.DetailSeparator + h.detail)
    }

    public get ActivityRows(): ObservableCollection<ActivityRowViewModel>
    {
        return this.activityRows
    }

    public get HasActivity(): boolean
    {
        return this.activityRows.Count > 0
    }

    public get HasNoActivity(): boolean
    {
        return !this.HasActivity
    }

    public get LogsOpen(): boolean
    {
        return this.logsOpen
    }

    public get LogsToggleLabel(): string
    {
        const D = EnvironmentDetailPageViewModel
        return this.logsOpen ? D.HideLogsLabel : D.ViewLogsLabel
    }

    public get Paused(): boolean
    {
        return this.paused
    }

    public get PauseLabel(): string
    {
        const D = EnvironmentDetailPageViewModel
        return this.paused ? D.ResumeText : D.PauseText
    }

    // The buffered log, or what to expect while there is none.
    public get LogText(): string
    {
        return this.logBuffer.length === 0 ? EnvironmentDetailPageViewModel.NoLogsText : this.logBuffer
    }

    public get LogBuffer(): string
    {
        return this.logBuffer
    }

    // Whether the log stream is open right now.
    public get IsStreaming(): boolean
    {
        return this.closeStream !== undefined
    }

    // Access.
    public get SignInAddress(): string
    {
        const env = this.environment?.Dto
        if (env?.idpBaseDomain === undefined)
        {
            return EnvironmentDetailPageViewModel.NotFederatedText
        }
        return env.environmentId + EnvironmentDetailPageViewModel.HostSeparator + env.idpBaseDomain
    }

    // Tabs: the SegmentedButton's labels and the selected one.
    public get TabLabels(): ObservableCollection<string>
    {
        return this.tabLabels
    }

    public get SelectedTab(): string
    {
        return this.tabLabels.ToArray()[this.tab] ?? EnvironmentDetailPageViewModel.ApplicationTabLabel
    }

    public set SelectedTab(value: string)
    {
        const index = this.tabLabels.ToArray().indexOf(value)
        if (index >= 0)
        {
            this.SelectTab(index as EnvironmentDetailTab)
        }
    }

    public get Tab(): EnvironmentDetailTab
    {
        return this.tab
    }

    public get IsApplicationTab(): boolean
    {
        return this.tab === EnvironmentDetailTab.Application
    }

    public get IsHealthTab(): boolean
    {
        return this.tab === EnvironmentDetailTab.Health
    }

    public get IsAccessTab(): boolean
    {
        return this.tab === EnvironmentDetailTab.Access
    }

    public get StartCommand(): RelayCommand
    {
        return this.startCommand
    }

    public get StopCommand(): RelayCommand
    {
        return this.stopCommand
    }

    public get RestartCommand(): RelayCommand
    {
        return this.restartCommand
    }

    public get DeleteCommand(): RelayCommand
    {
        return this.deleteCommand
    }

    public get ReviewAdoptCommand(): RelayCommand
    {
        return this.reviewAdoptCommand
    }

    public get ToggleLogsCommand(): RelayCommand
    {
        return this.toggleLogsCommand
    }

    public get TogglePauseCommand(): RelayCommand
    {
        return this.togglePauseCommand
    }

    public SelectTab(tab: EnvironmentDetailTab): void
    {
        const old = this.tab
        if (old === tab)
        {
            return
        }
        const D = EnvironmentDetailPageViewModel
        const was = [this.SelectedTab, this.IsApplicationTab, this.IsHealthTab, this.IsAccessTab] as const
        this.tab = tab
        this.RaisePropertyChanged(D.SelectedTabProperty, was[0], this.SelectedTab)
        this.RaisePropertyChanged(D.IsApplicationTabProperty, was[1], this.IsApplicationTab)
        this.RaisePropertyChanged(D.IsHealthTabProperty, was[2], this.IsHealthTab)
        this.RaisePropertyChanged(D.IsAccessTabProperty, was[3], this.IsAccessTab)
    }

    public OnShown(): void
    {
        this.shown = true
        this.activitySubscription ??= this.Session.Activity.PropertyChanged(ActivityLog.EntriesProperty)
            .subscribe(() => this.RebuildActivity())
        this.RebuildActivity()
        this.SyncStream()
    }

    public OnHidden(): void
    {
        this.shown = false
        this.activitySubscription?.dispose()
        this.activitySubscription = undefined
        this.SyncStream()
    }

    protected override get PageCapability(): AdminCapability
    {
        return AdminCapability.Environments
    }

    // The environment from the list (gone: Error), its health and the
    // published versions best-effort.
    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const environments = await this.Session.Client.ListEnvironments()
        const dto = environments.find(e => e.name === this.name)
        if (dto === undefined)
        {
            const D = EnvironmentDetailPageViewModel
            throw new Error(D.NotFoundTemplate.replace(D.NameToken, this.name))
        }
        const [health, manifests] = await Promise.all([
            this.LoadHealth(dto),
            BestEffort.Or(this.Session.Client.ListManifests(), [] as ManifestDto[]),
        ])
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.Apply(new EnvironmentRow(dto, health), manifests)
        this.RebuildActivity()
        return true
    }

    private async LoadHealth(dto: EnvironmentDto): Promise<HiveHealthDto | undefined>
    {
        const hiveId = dto.hiveId !== undefined && dto.hiveId !== ''
            ? dto.hiveId
            : await BestEffort.Or(this.Session.ResolveHiveId(), undefined)
        if (hiveId === undefined)
        {
            return undefined
        }
        const rows = await BestEffort.Or(this.Session.Client.GetHealth(hiveId), [] as HiveHealthDto[])
        return rows.find(r => r.environmentName === dto.name)
    }

    // Every getter derives from the environment and versions: raise them all.
    private Apply(environment: EnvironmentRow, manifests: readonly ManifestDto[]): void
    {
        const old = this.environment
        this.environment = environment
        this.statusPill = EnvironmentPillViewModel.Status(environment)
        this.healthPill = EnvironmentPillViewModel.Health(environment)
        this.manifests = manifests
        this.RaisePropertyChanged(EnvironmentDetailPageViewModel.EnvironmentProperty, old, environment)
        for (const property of EnvironmentDetailPageViewModel.DerivedProperties)
        {
            this.RaisePropertyChanged(property, undefined, (this as unknown as Record<string, unknown>)[property])
        }
        this.RaiseMutatingCommandsChanged()
    }

    private RebuildActivity(): void
    {
        const D = EnvironmentDetailPageViewModel
        const old = this.activityRows
        const had = this.HasActivity
        this.activityRows = ActivityRows.From(this.Session.Activity.EntriesFor(this.name))
        this.RaisePropertyChanged(D.ActivityRowsProperty, old, this.activityRows)
        this.RaisePropertyChanged(D.HasActivityProperty, had, this.HasActivity)
        this.RaisePropertyChanged(D.HasNoActivityProperty, !had, this.HasNoActivity)
    }

    private async Start(): Promise<void>
    {
        await this.Session.Client.StartEnvironment(this.name)
        await this.Refresh()
    }

    private async Restart(): Promise<void>
    {
        await this.Session.Client.RestartEnvironment(this.name)
        await this.Refresh()
    }

    private Stop(): Promise<void>
    {
        const D = EnvironmentDetailPageViewModel
        return this.Confirm(this.section.Dialogs, {
            Capability: AdminCapability.Environments,
            Title: D.StopTitleTemplate.replace(D.NameToken, this.name),
            Message: D.StopMessageTemplate.replace(D.NameToken, this.name),
            Consequences: D.StopConsequences,
            ConfirmLabel: D.StopLabel,
            Action: async () => { await this.Session.Client.StopEnvironment(this.name) },
            OnConfirmed: () => this.Refresh(),
        })
    }

    private Delete(): Promise<void>
    {
        const D = EnvironmentDetailPageViewModel
        return this.ConfirmByName(this.section.Dialogs, {
            Capability: AdminCapability.Environments,
            Expected: this.name,
            Title: D.DeleteTitleTemplate.replace(D.NameToken, this.name),
            Message: D.DeleteMessageTemplate.replace(D.NameToken, this.name),
            Consequences: D.DeleteConsequences,
            ConfirmLabel: D.DeleteLabel,
            Action: () => this.Session.Client.DeleteEnvironment(this.name),
            OnConfirmed: () => this.section.ReturnFromDeleted(this),
        })
    }

    private ReviewAdopt(): void
    {
        const offer = this.Offer
        if (offer !== undefined)
        {
            this.section.OpenAdopt(offer.id)
        }
    }

    private ToggleLogs(): void
    {
        const D = EnvironmentDetailPageViewModel
        const old = this.logsOpen
        const oldLabel = this.LogsToggleLabel
        this.logsOpen = !old
        this.RaisePropertyChanged(D.LogsOpenProperty, old, this.logsOpen)
        this.RaisePropertyChanged(D.LogsToggleLabelProperty, oldLabel, this.LogsToggleLabel)
        this.SyncStream()
    }

    private TogglePause(): void
    {
        const D = EnvironmentDetailPageViewModel
        const old = this.paused
        const oldLabel = this.PauseLabel
        this.paused = !old
        this.RaisePropertyChanged(D.PausedProperty, old, this.paused)
        this.RaisePropertyChanged(D.PauseLabelProperty, oldLabel, this.PauseLabel)
    }

    // Opens the stream when the panel is open on a shown page; closes it
    // otherwise.
    private SyncStream(): void
    {
        const want = this.logsOpen && this.shown
        if (want && this.closeStream === undefined)
        {
            this.closeStream = this.Session.Client.OpenLogStream(this.name, chunk => this.Append(chunk))
        }
        else if (!want && this.closeStream !== undefined)
        {
            const close = this.closeStream
            this.closeStream = undefined
            close()
        }
    }

    private Append(chunk: string): void
    {
        if (this.paused || this.closeStream === undefined)
        {
            return
        }
        const max = EnvironmentDetailPageViewModel.MaxLogChars
        const oldText = this.LogText
        const next = this.logBuffer + chunk
        this.logBuffer = next.length > max ? next.slice(next.length - max) : next
        this.RaisePropertyChanged(EnvironmentDetailPageViewModel.LogTextProperty, oldText, this.LogText)
    }
}
