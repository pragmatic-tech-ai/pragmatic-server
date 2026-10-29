import { JsonRecordStore } from './json-record-store.js'
import type { Channel } from './channel.js'

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
    private static readonly RootKey = 'releasePolicies'

    public constructor(filePath: string)
    {
        super(filePath, ReleasePolicyRegistry.RootKey)
    }
}
