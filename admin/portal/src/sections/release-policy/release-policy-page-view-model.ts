import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { PortalDates } from '../../portal-dates.js'
import type { GatingDto, HiveDto, LedgerDto, ManifestDto, PolicyDto } from '../../portal-types.js'
import { ReleaseChannel } from '../../release-channel.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { VersionOrder } from '../../version-order.js'
import { HiveLedgerRowViewModel } from '../hives/hive-detail-page-view-model.js'
import { GateDialogViewModel } from './gate-dialog-view-model.js'
import { PolicyEditDialogViewModel } from './policy-edit-dialog-view-model.js'
import { PolicyOwnerLabels } from './policy-owner-labels.js'
import { HivePolicyTarget, TenantPolicyTarget, type PolicyTarget } from './policy-target.js'
import type { ReleasePolicySectionService } from './release-policy-section-service.js'

// One release-policy rule: a tenant's (every hive of it) or one hive's.
export class PolicyRuleRowViewModel extends Observable
{
    private static readonly ChannelSeparator = ', '
    private static readonly NoHoldLabel = 'None'
    private static readonly HeldTemplate = 'Held: {reason}'
    private static readonly ReasonToken = '{reason}'

    public constructor(private readonly target: PolicyTarget, private readonly policy: PolicyDto | undefined, private readonly editCommand: RelayCommand)
    {
        super()
    }

    public get AppliesToLabel(): string
    {
        return this.target.Label
    }

    public get ScopeLabel(): string
    {
        return this.target.ScopeLabel
    }

    public get ChannelsLabel(): string
    {
        const channels = this.policy?.channels
        if (channels === undefined || channels.length === 0)
        {
            return this.target.UnsetChannelsLabel
        }
        return channels.map(c => ReleaseChannel.Label(c)).join(PolicyRuleRowViewModel.ChannelSeparator)
    }

    public get MinVersionLabel(): string
    {
        return this.policy?.minVersion ?? this.target.UnsetMinVersionLabel
    }

    public get HoldLabel(): string
    {
        const hold = this.policy?.hold
        return hold === undefined ? PolicyRuleRowViewModel.NoHoldLabel : PolicyRuleRowViewModel.HeldTemplate.replace(PolicyRuleRowViewModel.ReasonToken, hold.reason)
    }

    // Opens the rule in the policy editor (disabled for Observers).
    public get EditCommand(): RelayCommand
    {
        return this.editCommand
    }
}

// One version gated (allowed) for a tenant, and whether its policy still blocks it.
export class GatedVersionRowViewModel extends Observable
{
    public constructor(
        private readonly gating: GatingDto,
        public readonly OwnerLabel: string,
        public readonly BlockedLabel: string,
        private readonly ungateCommand: RelayCommand,
    )
    {
        super()
    }

    public get TenantId(): string
    {
        return this.gating.tenantId
    }

    public get Version(): string
    {
        return this.gating.version
    }

    public get GatedLabel(): string
    {
        return PortalDates.Label(this.gating.gatedAt)
    }

    // Removes the gate (disabled for Observers).
    public get UngateCommand(): RelayCommand
    {
        return this.ungateCommand
    }
}

// One adoption-ledger entry: what a hive did with a version, and when.
export class AdoptionLedgerRowViewModel extends Observable
{
    private readonly openHiveCommand: RelayCommand

    public constructor(private readonly entry: LedgerDto, public readonly HiveLabel: string, openHive: () => void)
    {
        super()
        this.openHiveCommand = new RelayCommand(() => openHive())
    }

    public get WhenLabel(): string
    {
        return PortalDates.Label(this.entry.at)
    }

    public get Version(): string
    {
        return this.entry.version
    }

    public get ActionLabel(): string
    {
        return HiveLedgerRowViewModel.LabelFor(this.entry.action)
    }

    public get OpenHiveCommand(): RelayCommand
    {
        return this.openHiveCommand
    }
}

// Release Policy: which versions each tenant's hives may adopt (the rules per
// tenant and per hive, and the versions gated for each tenant) and the record
// of what each hive did adopt. Edit, Gate and Ungate are Operator-only.
export class ReleasePolicyPageViewModel extends PortalPageViewModel
{
    private static readonly EditTitleTemplate = 'Edit policy: {name}'
    private static readonly NameToken = '{name}'
    private static readonly GateTitle = 'Gate a version'
    private static readonly AdoptableLabel = 'Adoptable'
    private static readonly BlockedPrefix = 'Blocked: '
    private static readonly ReasonSeparator = ', '
    private static readonly WithdrawnReason = 'withdrawn'
    private static readonly ChannelReason = 'channel'
    private static readonly HeldReason = 'held'
    private static readonly FloorReason = 'below minimum'
    private static readonly HasGatedProperty = 'HasGated'
    private static readonly HasNoGatedProperty = 'HasNoGated'
    private static readonly HasLedgerProperty = 'HasLedger'
    private static readonly HasNoLedgerProperty = 'HasNoLedger'

    private readonly policyRows = new ObservableCollection<PolicyRuleRowViewModel>()
    private readonly gatedRows = new ObservableCollection<GatedVersionRowViewModel>()
    private readonly ledgerRows = new ObservableCollection<AdoptionLedgerRowViewModel>()
    private readonly gateCommand: RelayCommand

    public constructor(session: PortalSessionService, private readonly section: ReleasePolicySectionService)
    {
        super(session)
        this.gateCommand = this.MutatingCommand(() => this.Gate())
    }

    public get PolicyRows(): ObservableCollection<PolicyRuleRowViewModel>
    {
        return this.policyRows
    }

    public get GatedRows(): ObservableCollection<GatedVersionRowViewModel>
    {
        return this.gatedRows
    }

    public get HasGated(): boolean
    {
        return this.gatedRows.Count > 0
    }

    public get HasNoGated(): boolean
    {
        return this.gatedRows.Count === 0
    }

    public get LedgerRows(): ObservableCollection<AdoptionLedgerRowViewModel>
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

    public get GateCommand(): RelayCommand
    {
        return this.gateCommand
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const api = this.Session.Client
        const [tenants, clients, hives, policies, gating, manifests] = await Promise.all([
            api.ListTenants(), api.ListClients(), api.ListHives(), api.ListPolicies(), api.ListGating(), api.ListManifests(),
        ])
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        const ledgers = await Promise.all(hives.map(h => api.ListHiveLedger(h.id)))
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        const hadGated = this.HasGated
        const hadLedger = this.HasLedger
        const owners = new PolicyOwnerLabels(tenants, clients)
        this.FillPolicies(owners, tenants.map(t => t.id), hives, policies)
        this.FillGated(owners, gating, policies, manifests)
        this.FillLedger(hives, ledgers)
        this.RaisePropertyChanged(ReleasePolicyPageViewModel.HasGatedProperty, hadGated, this.HasGated)
        this.RaisePropertyChanged(ReleasePolicyPageViewModel.HasNoGatedProperty, !hadGated, this.HasNoGated)
        this.RaisePropertyChanged(ReleasePolicyPageViewModel.HasLedgerProperty, hadLedger, this.HasLedger)
        this.RaisePropertyChanged(ReleasePolicyPageViewModel.HasNoLedgerProperty, !hadLedger, this.HasNoLedger)
        return this.policyRows.Count > 0 || this.gatedRows.Count > 0 || this.ledgerRows.Count > 0
    }

    // Each tenant's rule (by owner label), each followed by its hives' rules.
    private FillPolicies(owners: PolicyOwnerLabels, tenantIds: readonly string[], hives: readonly HiveDto[], policies: readonly PolicyDto[]): void
    {
        this.policyRows.Clear()
        const ordered = [...tenantIds].sort((a, b) => owners.For(a).localeCompare(owners.For(b)))
        const placed = new Set<string>()
        for (const tenantId of ordered)
        {
            this.AddRule(new TenantPolicyTarget(tenantId, owners.For(tenantId)), policies)
            for (const hive of hives.filter(h => h.tenantId === tenantId))
            {
                this.AddRule(new HivePolicyTarget(hive.id, hive.displayName), policies)
                placed.add(hive.id)
            }
        }
        for (const hive of hives.filter(h => !placed.has(h.id)))
        {
            this.AddRule(new HivePolicyTarget(hive.id, hive.displayName), policies)
        }
    }

    private AddRule(target: PolicyTarget, policies: readonly PolicyDto[]): void
    {
        const policy = target.Find(policies)
        this.policyRows.Add(new PolicyRuleRowViewModel(target, policy, this.MutatingCommand(() => this.Edit(target, policy))))
    }

    private FillGated(owners: PolicyOwnerLabels, gating: readonly GatingDto[], policies: readonly PolicyDto[], manifests: readonly ManifestDto[]): void
    {
        this.gatedRows.Clear()
        const manifestById = new Map<string, ManifestDto>(manifests.map(m => [m.id, m]))
        const rows = gating.map(g => new GatedVersionRowViewModel(g, owners.For(g.tenantId),
            ReleasePolicyPageViewModel.BlockedLabel(g.version, manifestById.get(g.version), policies.find(p => p.tenantId === g.tenantId && p.hiveId === undefined)),
            this.MutatingCommand(() => this.Ungate(g))))
        rows.sort((a, b) => a.OwnerLabel.localeCompare(b.OwnerLabel) || VersionOrder.Compare(a.Version, b.Version))
        for (const row of rows)
        {
            this.gatedRows.Add(row)
        }
    }

    // Newest first, across every hive.
    private FillLedger(hives: readonly HiveDto[], ledgers: readonly LedgerDto[][]): void
    {
        this.ledgerRows.Clear()
        const rows: Array<[string, AdoptionLedgerRowViewModel]> = []
        hives.forEach((hive, i) =>
        {
            for (const entry of ledgers[i] ?? [])
            {
                rows.push([entry.at, new AdoptionLedgerRowViewModel(entry, hive.displayName, () => this.section.OpenHive(hive.id))])
            }
        })
        rows.sort((a, b) => (a[0] === b[0] ? 0 : a[0] < b[0] ? 1 : -1))
        for (const [, row] of rows)
        {
            this.ledgerRows.Add(row)
        }
    }

    // Why the tenant's policy still blocks a gated version; Adoptable when nothing does.
    private static BlockedLabel(version: string, manifest: ManifestDto | undefined, policy: PolicyDto | undefined): string
    {
        const P = ReleasePolicyPageViewModel
        const reasons: string[] = []
        if (manifest?.withdrawn === true)
        {
            reasons.push(P.WithdrawnReason)
        }
        const channels = policy?.channels
        if (channels !== undefined && channels.length > 0 && !(channels as readonly string[]).includes(manifest?.channel ?? ReleaseChannel.Stable))
        {
            reasons.push(P.ChannelReason)
        }
        if (policy?.hold !== undefined)
        {
            reasons.push(P.HeldReason)
        }
        if (policy?.minVersion !== undefined && VersionOrder.Compare(version, policy.minVersion) < 0)
        {
            reasons.push(P.FloorReason)
        }
        return reasons.length === 0 ? P.AdoptableLabel : P.BlockedPrefix + reasons.join(P.ReasonSeparator)
    }

    private Edit(target: PolicyTarget, policy: PolicyDto | undefined): Promise<void>
    {
        const title = ReleasePolicyPageViewModel.EditTitleTemplate.replace(ReleasePolicyPageViewModel.NameToken, target.Label)
        return this.OpenCreate(this.section.Dialogs, dialogs => new PolicyEditDialogViewModel(this.Session, dialogs, target, policy),
            title, () => this.Refresh())
    }

    private Gate(): Promise<void>
    {
        return this.OpenCreate(this.section.Dialogs, dialogs => new GateDialogViewModel(this.Session, dialogs),
            ReleasePolicyPageViewModel.GateTitle, () => this.Refresh())
    }

    private async Ungate(gating: GatingDto): Promise<void>
    {
        await this.Session.Client.Ungate(gating.tenantId, gating.version)
        await this.Refresh()
    }
}
