import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { IStorageProviderRegistry } from '@pragmatic-tech-ai/todl'

/** Shared test fixture: an in-memory storage registry handing out one FakeStorage per location. */
export class MemoryStorageRegistry implements IStorageProviderRegistry
{
    private readonly stores = new Map<string, FakeStorage>()

    public CreateStorage(location: string): IStorage
    {
        let store = this.stores.get(location)
        if (store === undefined)
        {
            store = new FakeStorage(location)
            this.stores.set(location, store)
        }
        return store
    }
}
