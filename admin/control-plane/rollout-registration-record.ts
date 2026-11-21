import { JsonRecordStore, type IRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

export type RolloutRegistrationRecord = {
    id: string
    hiveId: string
    agentTokenHash: string
    registeredAt: string
}

export class RolloutRegistrationRegistry extends JsonRecordStore<RolloutRegistrationRecord>
{
    public static readonly RootKey = 'rolloutRegistrations'

    public constructor(location: string | IRecordMap<RolloutRegistrationRecord>)
    {
        super(location, RolloutRegistrationRegistry.RootKey)
    }
}
