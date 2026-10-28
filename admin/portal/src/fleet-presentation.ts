import { FleetConnection } from './fleet-view-model.js'
import { PillKind } from './kit/index.js'

// Shared presentation mappings for fleet data, reused by every view that shows a hive connection.
export class FleetPresentation
{
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
}
