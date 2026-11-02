import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { FleetViewModel } from '../../fleet-view-model.js'
import { PortalDates } from '../../portal-dates.js'
import type { EnvRolloutDto, FleetHiveDto, HiveRolloutDto, SelectionDto } from '../../portal-types.js'

// How a hive is named on the fleet-wide policy tables: its display name and
// its owner, from the fleet; placeholders for a hive the fleet doesn't list.
export class PolicyHiveNames
{
    private static readonly UnknownHiveLabel = '(unknown hive)'
    private static readonly UnassignedLabel = '(unassigned)'

    private readonly hives: ReadonlyMap<string, FleetHiveDto>

    public constructor(fleet: readonly FleetHiveDto[])
    {
        this.hives = new Map(fleet.map(h => [h.id, h]))
    }

    public Name(hiveId: string): string
    {
        return this.hives.get(hiveId)?.displayName ?? PolicyHiveNames.UnknownHiveLabel
    }

    public Owner(hiveId: string): string
    {
        const hive = this.hives.get(hiveId)
        return hive === undefined ? PolicyHiveNames.UnassignedLabel : FleetViewModel.OwnerLabel(hive)
    }
}

// One hive's selected target version: what its tenant chose to adopt.
export class SelectedTargetRowViewModel extends Observable
{
    public readonly HiveLabel: string
    public readonly OwnerLabel: string

    public constructor(private readonly selection: SelectionDto, names: PolicyHiveNames)
    {
        super()
        this.HiveLabel = names.Name(selection.hiveId)
        this.OwnerLabel = names.Owner(selection.hiveId)
    }

    public get TargetVersion(): string
    {
        return this.selection.targetVersion
    }

    public get SelectedLabel(): string
    {
        return PortalDates.Label(this.selection.selectedAt)
    }
}

// Where an environment stands against its hive's target (the server decides).
export enum RolloutState
{
    OnTarget,
    BehindTarget,
    NotReady,
    NoTarget,
}

// One environment of one hive, as reported, against the hive's target version.
export class RolloutRowViewModel extends Observable
{
    private static readonly NoTargetLabel = 'No target'
    private static readonly NotReportedLabel = 'Not reported'
    private static readonly StateLabels: ReadonlyMap<RolloutState, string> = new Map([
        [RolloutState.OnTarget, 'On target'],
        [RolloutState.BehindTarget, 'Behind target'],
        [RolloutState.NotReady, 'Not ready'],
        [RolloutState.NoTarget, RolloutRowViewModel.NoTargetLabel],
    ])

    public readonly HiveLabel: string
    public readonly OwnerLabel: string

    public constructor(private readonly rollout: HiveRolloutDto, private readonly env: EnvRolloutDto, names: PolicyHiveNames)
    {
        super()
        this.HiveLabel = names.Name(rollout.hiveId)
        this.OwnerLabel = names.Owner(rollout.hiveId)
    }

    public get Environment(): string
    {
        return this.env.environmentName
    }

    public get TargetLabel(): string
    {
        return this.rollout.targetVersion ?? RolloutRowViewModel.NoTargetLabel
    }

    public get RunningLabel(): string
    {
        return this.env.runningImage ?? RolloutRowViewModel.NotReportedLabel
    }

    public get State(): RolloutState
    {
        if (this.rollout.targetVersion === undefined)
        {
            return RolloutState.NoTarget
        }
        if (this.env.obsolete)
        {
            return RolloutState.BehindTarget
        }
        return this.env.ready ? RolloutState.OnTarget : RolloutState.NotReady
    }

    public get StatusLabel(): string
    {
        return RolloutRowViewModel.StateLabels.get(this.State) ?? RolloutRowViewModel.NoTargetLabel
    }
}
