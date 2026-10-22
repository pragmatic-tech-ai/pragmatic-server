import { JsonRecordStore } from './json-record-store.js'
import type { ClientRecord } from './platform-records.js'

export class ClientRegistry extends JsonRecordStore<ClientRecord>
{
    private static readonly RootKey = 'clients'

    public constructor(filePath: string)
    {
        super(filePath, ClientRegistry.RootKey)
    }
}
