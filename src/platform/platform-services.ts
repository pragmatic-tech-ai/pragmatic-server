import type { IStorage, IPromptService } from '@pragmatic-tech-ai/todl-runtime'
import type { IStorageProviderRegistry } from '@pragmatic-tech-ai/todl'
import type { IdentityStoreSet, ITenantConfigStore } from '@pragmatic-tech-ai/todl-identity'
import type { IDocumentSession } from '@pragmatic-tech-ai/todl-connectors-host'
import type { BuiltinStoreEngine } from '../host/connectors/builtin-store-engine.js'
import type { MasterKeyRef } from '../identity/master-key-resolver.js'

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
    CreateTenantConfigStore(configRoot: string): Promise<ITenantConfigStore>
    CreateAppDataStore(dataRoot: string, engine: BuiltinStoreEngine): IDocumentSession
}
