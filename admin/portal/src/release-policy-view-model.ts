import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { ClientDto, EnvRolloutDto, FleetHiveDto, GatingDto, HiveRolloutDto, ManifestDto, PolicyDto, SelectionDto, TenantDto } from './portal-types.js'
import { PortalDates } from './portal-dates.js'
import { FleetViewModel } from './fleet-view-model.js'
import { PillTone } from './kit/tones.js'
import { VersionOrder } from './version-order.js'

export interface GatedRow
{
    ownerLabel: string
    version: string
    gatedLabel: string
    blockedLabel?: string
}

export interface PolicyRow
{
    ownerLabel: string
    tenantId: string
    channelsLabel: string
    minVersionLabel: string
    heldLabel: string
    held: boolean
    holdReason: string
}

export interface TargetRow
{
    hiveName: string
    ownerLabel: string
    targetVersion: string
    selectedLabel: string
}

export enum RolloutStatus
{
    OnTarget,
    BehindTarget,
    NotReady,
    NoTarget,
}

export interface RolloutRow
{
    hiveName: string
    ownerLabel: string
    envName: string
    targetLabel: string
    runningLabel: string
    statusLabel: string
    statusTone: PillTone
}

// Release policy screen: gating allowlist and per-hive target selections, joined to readable names.
export class ReleasePolicyViewModel extends Observable
{
    public static readonly GatedRowsProperty = 'GatedRows'
    public static readonly TargetRowsProperty = 'TargetRows'
    public static readonly RolloutRowsProperty = 'RolloutRows'
    public static readonly PolicyRowsProperty = 'PolicyRows'

    private static readonly OwnerSeparator = ' / '
    private static readonly UnknownOwnerLabel = '(unknown)'
    private static readonly UnknownHiveLabel = '(unknown hive)'
    // Same text FleetViewModel.OwnerLabel yields for a hive with no owner.
    private static readonly UnassignedLabel = '(unassigned)'
    private static readonly NoTargetLabel = 'No target'
    private static readonly NotReportedLabel = 'Not reported'
    private static readonly OnTargetLabel = 'On target'
    private static readonly BehindTargetLabel = 'Behind target'
    private static readonly NotReadyLabel = 'Not ready'
    private static readonly ChannelSeparator = ', '
    private static readonly AllChannelsLabel = 'All channels'
    private static readonly NoFloorLabel = 'No floor'
    private static readonly HeldLabel = 'Held'
    private static readonly NotHeldLabel = 'Active'
    private static readonly BlockedPrefix = 'Blocked: '
    private static readonly ReasonSeparator = ', '
    private static readonly WithdrawnReason = 'withdrawn'
    private static readonly ChannelReason = 'channel'
    private static readonly HeldReason = 'held'
    private static readonly FloorReason = 'below floor'
    private static readonly DefaultChannel = 'stable'
    private static readonly NoHoldReason = ''

    private gatedRows: readonly GatedRow[] = []
    private targetRows: readonly TargetRow[] = []
    private rolloutRows: readonly RolloutRow[] = []
    private policyRows: readonly PolicyRow[] = []

    public constructor(
        gating: readonly GatingDto[],
        selections: readonly SelectionDto[],
        tenants: readonly TenantDto[],
        clients: readonly ClientDto[],
        fleet: readonly FleetHiveDto[],
        rollouts: readonly HiveRolloutDto[] = [],
        policies: readonly PolicyDto[] = [],
        manifests: readonly ManifestDto[] = [])
    {
        super()
        this.gatedRows = ReleasePolicyViewModel.DeriveGated(gating, tenants, clients, policies, manifests)
        this.targetRows = ReleasePolicyViewModel.DeriveTargets(selections, fleet)
        this.rolloutRows = ReleasePolicyViewModel.DeriveRollouts(rollouts, fleet)
        this.policyRows = ReleasePolicyViewModel.DerivePolicies(policies, tenants, clients)
    }

    public get GatedRows(): readonly GatedRow[]
    {
        return this.gatedRows
    }

    public get TargetRows(): readonly TargetRow[]
    {
        return this.targetRows
    }

    public get RolloutRows(): readonly RolloutRow[]
    {
        return this.rolloutRows
    }

    public get PolicyRows(): readonly PolicyRow[]
    {
        return this.policyRows
    }

    public Update(
        gating: readonly GatingDto[],
        selections: readonly SelectionDto[],
        tenants: readonly TenantDto[],
        clients: readonly ClientDto[],
        fleet: readonly FleetHiveDto[],
        rollouts: readonly HiveRolloutDto[] = [],
        policies: readonly PolicyDto[] = [],
        manifests: readonly ManifestDto[] = []): void
    {
        const oldGated = this.gatedRows
        const oldTargets = this.targetRows
        const oldRollouts = this.rolloutRows
        const oldPolicies = this.policyRows
        this.gatedRows = ReleasePolicyViewModel.DeriveGated(gating, tenants, clients, policies, manifests)
        this.targetRows = ReleasePolicyViewModel.DeriveTargets(selections, fleet)
        this.rolloutRows = ReleasePolicyViewModel.DeriveRollouts(rollouts, fleet)
        this.policyRows = ReleasePolicyViewModel.DerivePolicies(policies, tenants, clients)
        this.RaisePropertyChanged(ReleasePolicyViewModel.GatedRowsProperty, oldGated, this.gatedRows)
        this.RaisePropertyChanged(ReleasePolicyViewModel.TargetRowsProperty, oldTargets, this.targetRows)
        this.RaisePropertyChanged(ReleasePolicyViewModel.RolloutRowsProperty, oldRollouts, this.rolloutRows)
        this.RaisePropertyChanged(ReleasePolicyViewModel.PolicyRowsProperty, oldPolicies, this.policyRows)
    }

    private static DeriveGated(
        gating: readonly GatingDto[],
        tenants: readonly TenantDto[],
        clients: readonly ClientDto[],
        policies: readonly PolicyDto[],
        manifests: readonly ManifestDto[]): GatedRow[]
    {
        const policyByTenant = new Map<string, PolicyDto>(policies.map(p => [p.tenantId, p]))
        const manifestById = new Map<string, ManifestDto>(manifests.map(m => [m.id, m]))
        const tenantById = new Map<string, TenantDto>(tenants.map(t => [t.id, t]))
        const clientById = new Map<string, ClientDto>(clients.map(c => [c.id, c]))
        const rows: GatedRow[] = gating.map(g => ({
            ownerLabel: ReleasePolicyViewModel.GateOwner(g.tenantId, tenantById, clientById),
            version: g.version,
            gatedLabel: PortalDates.Label(g.gatedAt),
            blockedLabel: ReleasePolicyViewModel.BlockedLabel(g.version, manifestById.get(g.version), policyByTenant.get(g.tenantId)),
        }))
        // Array.prototype.sort is stable.
        return rows.sort((a, b) => a.ownerLabel.localeCompare(b.ownerLabel) || a.version.localeCompare(b.version))
    }

    private static BlockedLabel(version: string, manifest: ManifestDto | undefined, policy: PolicyDto | undefined): string | undefined
    {
        const reasons: string[] = []
        if (manifest?.withdrawn === true)
        {
            reasons.push(ReleasePolicyViewModel.WithdrawnReason)
        }
        const channels = policy?.channels
        if (channels !== undefined && channels.length > 0
            && !channels.includes(manifest?.channel ?? ReleasePolicyViewModel.DefaultChannel))
        {
            reasons.push(ReleasePolicyViewModel.ChannelReason)
        }
        if (policy?.hold !== undefined)
        {
            reasons.push(ReleasePolicyViewModel.HeldReason)
        }
        if (policy?.minVersion !== undefined && VersionOrder.Compare(version, policy.minVersion) < 0)
        {
            reasons.push(ReleasePolicyViewModel.FloorReason)
        }
        return reasons.length === 0
            ? undefined
            : ReleasePolicyViewModel.BlockedPrefix + reasons.join(ReleasePolicyViewModel.ReasonSeparator)
    }

    private static DerivePolicies(
        policies: readonly PolicyDto[],
        tenants: readonly TenantDto[],
        clients: readonly ClientDto[]): PolicyRow[]
    {
        const tenantById = new Map<string, TenantDto>(tenants.map(t => [t.id, t]))
        const clientById = new Map<string, ClientDto>(clients.map(c => [c.id, c]))
        const rows: PolicyRow[] = policies.map(p =>
        {
            const held = p.hold !== undefined
            return {
                ownerLabel: ReleasePolicyViewModel.GateOwner(p.tenantId, tenantById, clientById),
                tenantId: p.tenantId,
                channelsLabel: p.channels !== undefined && p.channels.length > 0
                    ? p.channels.join(ReleasePolicyViewModel.ChannelSeparator)
                    : ReleasePolicyViewModel.AllChannelsLabel,
                minVersionLabel: p.minVersion !== undefined ? p.minVersion : ReleasePolicyViewModel.NoFloorLabel,
                heldLabel: held ? ReleasePolicyViewModel.HeldLabel : ReleasePolicyViewModel.NotHeldLabel,
                held,
                holdReason: p.hold?.reason ?? ReleasePolicyViewModel.NoHoldReason,
            }
        })
        return rows.sort((a, b) => a.ownerLabel.localeCompare(b.ownerLabel) || a.tenantId.localeCompare(b.tenantId))
    }

    private static GateOwner(
        tenantId: string,
        tenantById: Map<string, TenantDto>,
        clientById: Map<string, ClientDto>): string
    {
        const tenant = tenantById.get(tenantId)
        if (tenant === undefined)
        {
            return ReleasePolicyViewModel.UnknownOwnerLabel
        }
        const client = clientById.get(tenant.clientId)
        if (client === undefined)
        {
            return tenant.displayName
        }
        return client.displayName + ReleasePolicyViewModel.OwnerSeparator + tenant.displayName
    }

    private static DeriveTargets(selections: readonly SelectionDto[], fleet: readonly FleetHiveDto[]): TargetRow[]
    {
        const hiveById = new Map<string, FleetHiveDto>(fleet.map(h => [h.id, h]))
        const rows: TargetRow[] = selections.map(s =>
        {
            const hive = hiveById.get(s.hiveId)
            return {
                hiveName: hive !== undefined ? hive.displayName : ReleasePolicyViewModel.UnknownHiveLabel,
                ownerLabel: hive !== undefined ? FleetViewModel.OwnerLabel(hive) : ReleasePolicyViewModel.UnassignedLabel,
                targetVersion: s.targetVersion,
                selectedLabel: PortalDates.Label(s.selectedAt),
            }
        })
        return rows.sort((a, b) => a.hiveName.localeCompare(b.hiveName))
    }

    private static DeriveRollouts(rollouts: readonly HiveRolloutDto[], fleet: readonly FleetHiveDto[]): RolloutRow[]
    {
        const hiveById = new Map<string, FleetHiveDto>(fleet.map(h => [h.id, h]))
        const rows: RolloutRow[] = []
        for (const rollout of rollouts)
        {
            const hive = hiveById.get(rollout.hiveId)
            for (const env of rollout.environments)
            {
                const status = ReleasePolicyViewModel.StatusOf(rollout, env)
                rows.push({
                    hiveName: hive !== undefined ? hive.displayName : ReleasePolicyViewModel.UnknownHiveLabel,
                    ownerLabel: hive !== undefined ? FleetViewModel.OwnerLabel(hive) : ReleasePolicyViewModel.UnassignedLabel,
                    envName: env.environmentName,
                    targetLabel: rollout.targetVersion !== undefined ? rollout.targetVersion : ReleasePolicyViewModel.NoTargetLabel,
                    runningLabel: env.runningImage !== undefined ? env.runningImage : ReleasePolicyViewModel.NotReportedLabel,
                    statusLabel: ReleasePolicyViewModel.StatusLabel(status),
                    statusTone: ReleasePolicyViewModel.StatusTone(status),
                })
            }
        }
        return rows.sort((a, b) => a.hiveName.localeCompare(b.hiveName) || a.envName.localeCompare(b.envName))
    }

    // Authoritative: only the server's targetVersion / obsolete / ready decide the status.
    private static StatusOf(rollout: HiveRolloutDto, env: EnvRolloutDto): RolloutStatus
    {
        if (rollout.targetVersion === undefined)
        {
            return RolloutStatus.NoTarget
        }
        if (env.obsolete === true)
        {
            return RolloutStatus.BehindTarget
        }
        return env.ready === true ? RolloutStatus.OnTarget : RolloutStatus.NotReady
    }

    private static StatusLabel(status: RolloutStatus): string
    {
        switch (status)
        {
            case RolloutStatus.OnTarget: return ReleasePolicyViewModel.OnTargetLabel
            case RolloutStatus.BehindTarget: return ReleasePolicyViewModel.BehindTargetLabel
            case RolloutStatus.NotReady: return ReleasePolicyViewModel.NotReadyLabel
            case RolloutStatus.NoTarget: return ReleasePolicyViewModel.NoTargetLabel
        }
    }

    private static StatusTone(status: RolloutStatus): PillTone
    {
        switch (status)
        {
            case RolloutStatus.OnTarget: return PillTone.Success
            case RolloutStatus.BehindTarget: return PillTone.Warning
            case RolloutStatus.NotReady: return PillTone.Warning
            case RolloutStatus.NoTarget: return PillTone.Neutral
        }
    }
}
