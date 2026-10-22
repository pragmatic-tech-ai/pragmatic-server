import type { EnvironmentRecord } from './environment-record.js'
import { EnvironmentWorkloadFactory } from './environment-workload.js'
import type { EnvironmentWorkload } from './environment-workload.js'
import type { PlatformDirectory } from './platform-directory.js'

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
    public constructor(private readonly directory: PlatformDirectory)
    {
    }

    public WorkloadFor(record: EnvironmentRecord): EnvironmentWorkload
    {
        if (!record.hiveId)
        {
            throw new EnvironmentNotPlacedError(record.name)
        }
        this.directory.ValidateHivePlacement(record.tenantId, record.hiveId)
        const hive = this.directory.GetHive(record.hiveId)!
        return EnvironmentWorkloadFactory.From(record, hive)
    }
}
