import { JsonRecordStore } from './json-record-store.js'

export type RolloutRegistrationRecord = {
    id: string
    hiveId: string
    agentTokenHash: string
    registeredAt: string
}

export class RolloutRegistrationRegistry extends JsonRecordStore<RolloutRegistrationRecord>
{
    private static readonly RootKey = 'rolloutRegistrations'

    public constructor(filePath: string)
    {
        super(filePath, RolloutRegistrationRegistry.RootKey)
    }
}
