import { JsonRecordStore } from './json-record-store.js'
import type { IRecordMap } from './record-map.js'
import type { ClientRecord } from './platform-records.js'

export class ClientRegistry extends JsonRecordStore<ClientRecord>
{
    public static readonly RootKey = 'clients'

    public constructor(location: string | IRecordMap<ClientRecord>)
    {
        super(location, ClientRegistry.RootKey)
    }
}
