import { JsonRecordStore, type IRecordMap, type ClientRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

export class ClientRegistry extends JsonRecordStore<ClientRecord>
{
    public static readonly RootKey = 'clients'

    public constructor(location: string | IRecordMap<ClientRecord>)
    {
        super(location, ClientRegistry.RootKey)
    }
}
