import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { ClientDto, EnvRolloutDto, FleetHiveDto, GatingDto, HiveRolloutDto, SelectionDto, TenantDto } from './portal-types.js'
import { PortalDates } from './portal-dates.js'
import { FleetViewModel } from './fleet-view-model.js'
import { PillTone } from './kit/tones.js'

export interface GatedRow
{
    ownerLabel: string
    version: string
    gatedLabel: string
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

    private gatedRows: readonly GatedRow[] = []
    private targetRows: readonly TargetRow[] = []
    private rolloutRows: readonly RolloutRow[] = []

    public constructor(
        gating: readonly GatingDto[],
        selections: readonly SelectionDto[],
        tenants: readonly TenantDto[],
        clients: readonly ClientDto[],
        fleet: readonly FleetHiveDto[],
        rollouts: readonly HiveRolloutDto[] = [])
    {
        super()
        this.gatedRows = ReleasePolicyViewModel.DeriveGated(gating, tenants, clients)
        this.targetRows = ReleasePolicyViewModel.DeriveTargets(selections, fleet)
        this.rolloutRows = ReleasePolicyViewModel.DeriveRollouts(rollouts, fleet)
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

    public Update(
        gating: readonly GatingDto[],
        selections: readonly SelectionDto[],
        tenants: readonly TenantDto[],
        clients: readonly ClientDto[],
        fleet: readonly FleetHiveDto[],
        rollouts: readonly HiveRolloutDto[] = []): void
    {
        const oldGated = this.gatedRows
        const oldTargets = this.targetRows
        const oldRollouts = this.rolloutRows
        this.gatedRows = ReleasePolicyViewModel.DeriveGated(gating, tenants, clients)
        this.targetRows = ReleasePolicyViewModel.DeriveTargets(selections, fleet)
        this.rolloutRows = ReleasePolicyViewModel.DeriveRollouts(rollouts, fleet)
        this.RaisePropertyChanged(ReleasePolicyViewModel.GatedRowsProperty, oldGated, this.gatedRows)
        this.RaisePropertyChanged(ReleasePolicyViewModel.TargetRowsProperty, oldTargets, this.targetRows)
        this.RaisePropertyChanged(ReleasePolicyViewModel.RolloutRowsProperty, oldRollouts, this.rolloutRows)
    }

    private static DeriveGated(
        gating: readonly GatingDto[],
        tenants: readonly TenantDto[],
        clients: readonly ClientDto[]): GatedRow[]
    {
        const tenantById = new Map<string, TenantDto>(tenants.map(t => [t.id, t]))
        const clientById = new Map<string, ClientDto>(clients.map(c => [c.id, c]))
        const rows: GatedRow[] = gating.map(g => ({
            ownerLabel: ReleasePolicyViewModel.GateOwner(g.tenantId, tenantById, clientById),
            version: g.version,
            gatedLabel: PortalDates.Label(g.gatedAt),
        }))
        // Array.prototype.sort is stable.
        return rows.sort((a, b) => a.ownerLabel.localeCompare(b.ownerLabel) || a.version.localeCompare(b.version))
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
