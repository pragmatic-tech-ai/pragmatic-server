import { JsonRecordStore } from './json-record-store.js'
import type { IRecordMap } from './record-map.js'

export type RolloutRegistrationRecord = {
    id: string
    hiveId: string
    agentTokenHash: string
    registeredAt: string
}

export class RolloutRegistrationRegistry extends JsonRecordStore<RolloutRegistrationRecord>
{
    private static readonly RootKey = 'rolloutRegistrations'

    public constructor(location: string | IRecordMap<RolloutRegistrationRecord>)
    {
        super(location, RolloutRegistrationRegistry.RootKey)
    }
}
