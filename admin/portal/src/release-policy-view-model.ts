import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { ClientDto, FleetHiveDto, GatingDto, SelectionDto, TenantDto } from './portal-types.js'
import { PortalDates } from './portal-dates.js'
import { FleetViewModel } from './fleet-view-model.js'

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

// Release policy screen: gating allowlist and per-hive target selections, joined to readable names.
export class ReleasePolicyViewModel extends Observable
{
    public static readonly GatedRowsProperty = 'GatedRows'
    public static readonly TargetRowsProperty = 'TargetRows'

    private static readonly OwnerSeparator = ' / '
    private static readonly UnknownOwnerLabel = '(unknown)'
    private static readonly UnknownHiveLabel = '(unknown hive)'
    // Same text FleetViewModel.OwnerLabel yields for a hive with no owner.
    private static readonly UnassignedLabel = '(unassigned)'

    private gatedRows: readonly GatedRow[] = []
    private targetRows: readonly TargetRow[] = []

    public constructor(
        gating: readonly GatingDto[],
        selections: readonly SelectionDto[],
        tenants: readonly TenantDto[],
        clients: readonly ClientDto[],
        fleet: readonly FleetHiveDto[])
    {
        super()
        this.gatedRows = ReleasePolicyViewModel.DeriveGated(gating, tenants, clients)
        this.targetRows = ReleasePolicyViewModel.DeriveTargets(selections, fleet)
    }

    public get GatedRows(): readonly GatedRow[]
    {
        return this.gatedRows
    }

    public get TargetRows(): readonly TargetRow[]
    {
        return this.targetRows
    }

    public Update(
        gating: readonly GatingDto[],
        selections: readonly SelectionDto[],
        tenants: readonly TenantDto[],
        clients: readonly ClientDto[],
        fleet: readonly FleetHiveDto[]): void
    {
        const oldGated = this.gatedRows
        const oldTargets = this.targetRows
        this.gatedRows = ReleasePolicyViewModel.DeriveGated(gating, tenants, clients)
        this.targetRows = ReleasePolicyViewModel.DeriveTargets(selections, fleet)
        this.RaisePropertyChanged(ReleasePolicyViewModel.GatedRowsProperty, oldGated, this.gatedRows)
        this.RaisePropertyChanged(ReleasePolicyViewModel.TargetRowsProperty, oldTargets, this.targetRows)
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
}
