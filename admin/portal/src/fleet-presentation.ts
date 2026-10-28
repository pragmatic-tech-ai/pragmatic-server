import { FleetConnection } from './fleet-view-model.js'
import { PillKind } from './kit/index.js'
import type { FleetHiveDto } from './portal-types.js'

// Shared presentation mappings for fleet data, reused by every view that shows a hive connection.
export class FleetPresentation
{
    private static readonly OwnerSeparator = ' / '
    private static readonly UnassignedLabel = '(unassigned)'

    public static ConnectionKind(c: FleetConnection): PillKind
    {
        switch (c)
        {
            case FleetConnection.Connected:
                return PillKind.Connected
            case FleetConnection.Quiet:
                return PillKind.Quiet
            default:
                return PillKind.Awaiting
        }
    }

    public static OwnerLabel(hive: FleetHiveDto): string
    {
        const parts = [hive.client?.displayName, hive.tenant?.displayName].filter((p): p is string => !!p)
        return parts.length > 0 ? parts.join(FleetPresentation.OwnerSeparator) : FleetPresentation.UnassignedLabel
    }
}
