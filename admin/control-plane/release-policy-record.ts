import { JsonRecordStore } from './json-record-store.js'
import type { IRecordMap } from './record-map.js'
import type { Channel } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

export type ReleasePolicyRecord = {
    id: string
    tenantId: string
    hiveId?: string
    channels?: Channel[]
    minVersion?: string
    hold?: { reason: string; actor: string; at: string }
}

export class ReleasePolicyRegistry extends JsonRecordStore<ReleasePolicyRecord>
{
    public static readonly RootKey = 'releasePolicies'

    public constructor(location: string | IRecordMap<ReleasePolicyRecord>)
    {
        super(location, ReleasePolicyRegistry.RootKey)
    }
}
