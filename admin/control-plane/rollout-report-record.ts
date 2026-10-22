import { JsonRecordStore } from './json-record-store.js'

export type RolloutReportRecord = {
    id: string
    hiveId: string
    environmentName: string
    runningImage: string
    ready: boolean
    reportedAt: string
}

export class RolloutReportRegistry extends JsonRecordStore<RolloutReportRecord>
{
    private static readonly RootKey = 'rolloutReports'

    public constructor(filePath: string)
    {
        super(filePath, RolloutReportRegistry.RootKey)
    }
}
