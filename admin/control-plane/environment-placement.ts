import type { EnvironmentRecord } from './environment-record.js'
import { EnvironmentWorkloadFactory } from './environment-workload.js'
import type { EnvironmentWorkload } from './environment-workload.js'
import { HivePlacementError } from './hive-placement-error.js'
import type { ITenantDirectory } from './tenant-api/tenant-directory.js'

/** An environment with no hive binding cannot be scheduled on a hive. */
export class EnvironmentNotPlacedError extends Error
{
    private static readonly MessagePrefix = 'Environment is not placed on a hive: '
    private static readonly ErrorName = 'EnvironmentNotPlacedError'

    public constructor(environmentName: string)
    {
        super(EnvironmentNotPlacedError.MessagePrefix + environmentName)
        this.name = EnvironmentNotPlacedError.ErrorName
    }
}

/** Binds an environment to its hive: validates tenant ownership, then builds the schedulable workload. */
export class EnvironmentPlacement
{
    public constructor(private readonly directory: ITenantDirectory)
    {
    }

    public WorkloadFor(record: EnvironmentRecord): EnvironmentWorkload
    {
        if (!record.hiveId)
        {
            throw new EnvironmentNotPlacedError(record.name)
        }
        const hive = this.directory.GetHive(record.hiveId)
        if (record.tenantId)
        {
            HivePlacementError.Assert(hive, record.tenantId, record.hiveId)
        }
        return EnvironmentWorkloadFactory.From(record, hive!)
    }
}
