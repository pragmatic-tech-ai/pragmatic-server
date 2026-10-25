import type { HiveRecord } from './platform-records.js'

/** A hive does not exist or does not belong to the tenant an environment claims. */
export class HivePlacementError extends Error
{
    private static readonly ErrorName = 'HivePlacementError'
    private static readonly MessagePrefix = 'Hive does not belong to tenant: '
    private static readonly Separator = ' / '

    public constructor(tenantId: string, hiveId: string)
    {
        super(HivePlacementError.MessagePrefix + hiveId + HivePlacementError.Separator + tenantId)
        this.name = HivePlacementError.ErrorName
    }

    /** The single home of the ownership rule: throws unless the hive exists and belongs to the tenant. */
    public static Assert(hive: HiveRecord | undefined, tenantId: string, hiveId: string): void
    {
        if (hive === undefined || hive.tenantId !== tenantId)
        {
            throw new HivePlacementError(tenantId, hiveId)
        }
    }
}
