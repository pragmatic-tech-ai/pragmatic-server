import type { IStorage, IPromptService } from '@pragmatic-tech-ai/todl-runtime'
import type { IStorageProviderRegistry } from '@pragmatic-tech-ai/todl'
import type { IdentityStoreSet, IRealmConfigStore } from '@pragmatic-tech-ai/pragmatic-identity'
import type { MasterKeyRef } from '@pragmatic-tech-ai/pragmatic-env-cluster'

/** The platform-impl bundle a PragmaticServer composes its infrastructure from. NodePlatform is the
 *  local/default set; a cloud bundle supplies object-store storage, a cloud secret manager, and
 *  DB-backed identity stores behind the same methods, with no change to the request path. */
export interface PlatformServices
{
    CreateStorageProviderRegistry(): IStorageProviderRegistry
    CreateStorage(root: string): IStorage
    CreatePackagesStorage(packagesRoot: string): IStorage
    CreatePromptService(): IPromptService
    ResolveMasterKey(ref: MasterKeyRef): Buffer
    CreateIdentityStores(identityRoot: string, masterKey: Buffer): Promise<IdentityStoreSet>
    CreateRealmConfigStore(configRoot: string): Promise<IRealmConfigStore>
}
