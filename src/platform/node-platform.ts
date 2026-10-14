import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import type { IStorage, IPromptService } from '@pragmatic-tech-ai/todl-runtime'
import type { IStorageProviderRegistry } from '@pragmatic-tech-ai/todl'
import { NodeStorageProviderRegistry, HeadlessPromptService } from '@pragmatic-tech-ai/todl-platform-node'
import { FileIdentityStores, FileTenantConfigStore } from '@pragmatic-tech-ai/todl-identity-node'
import type { IdentityStoreSet, ITenantConfigStore } from '@pragmatic-tech-ai/todl-identity'
import { MasterKeyResolver } from '../identity/master-key-resolver.js'
import type { MasterKeyRef } from '../identity/master-key-resolver.js'
import type { PlatformServices } from './platform-services.js'

/** The default (local/self-hosted) platform bundle: NodeFs storage, headless prompts, file-backed identity —
 *  the exact concretes the server wired directly before 5C-i. */
export class NodePlatform implements PlatformServices
{
    public CreateStorageProviderRegistry(): IStorageProviderRegistry
    {
        return new NodeStorageProviderRegistry()
    }

    public CreateStorage(root: string): IStorage
    {
        return new NodeFsStorage(root)
    }

    public CreatePackagesStorage(packagesRoot: string): IStorage
    {
        return this.CreateStorage(packagesRoot)
    }

    public CreatePromptService(): IPromptService
    {
        return new HeadlessPromptService()
    }

    public ResolveMasterKey(ref: MasterKeyRef): Buffer
    {
        return MasterKeyResolver.Resolve(ref)
    }

    public CreateIdentityStores(identityRoot: string, masterKey: Buffer): Promise<IdentityStoreSet>
    {
        return FileIdentityStores.Open(new NodeFsStorage(identityRoot), masterKey)
    }

    public CreateTenantConfigStore(configRoot: string): Promise<ITenantConfigStore>
    {
        return FileTenantConfigStore.Open(new NodeFsStorage(configRoot))
    }
}
