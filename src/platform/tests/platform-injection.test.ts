import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IStorage, IPromptService } from '@pragmatic-tech-ai/todl-runtime'
import type { IStorageProviderRegistry } from '@pragmatic-tech-ai/todl'
import type { IdentityStoreSet, ITenantConfigStore } from '@pragmatic-tech-ai/todl-identity'
import { NodePlatform } from '../node-platform.js'
import type { PlatformServices } from '../platform-services.js'
import type { MasterKeyRef } from '../../identity/master-key-resolver.js'
import { PragmaticServer } from '../../pragmatic-server.js'

class RecordingPlatform implements PlatformServices
{
    public static readonly RegistryCall = 'registry'
    public static readonly PackagesCall = 'packages'
    public static readonly PromptCall = 'prompt'
    public static readonly MasterKeyCall = 'masterKey'
    public static readonly IdentityStoresCall = 'identityStores'
    public static readonly TenantConfigCall = 'tenantConfig'

    private readonly inner = new NodePlatform()
    public readonly calls: string[] = []

    public CreateStorageProviderRegistry(): IStorageProviderRegistry
    {
        this.calls.push(RecordingPlatform.RegistryCall)
        return this.inner.CreateStorageProviderRegistry()
    }

    public CreateStorage(root: string): IStorage
    {
        return this.inner.CreateStorage(root)
    }

    public CreatePackagesStorage(packagesRoot: string): IStorage
    {
        this.calls.push(RecordingPlatform.PackagesCall)
        return this.inner.CreatePackagesStorage(packagesRoot)
    }

    public CreatePromptService(): IPromptService
    {
        this.calls.push(RecordingPlatform.PromptCall)
        return this.inner.CreatePromptService()
    }

    public ResolveMasterKey(ref: MasterKeyRef): Buffer
    {
        this.calls.push(RecordingPlatform.MasterKeyCall)
        return this.inner.ResolveMasterKey(ref)
    }

    public CreateIdentityStores(identityRoot: string, masterKey: Buffer): Promise<IdentityStoreSet>
    {
        this.calls.push(RecordingPlatform.IdentityStoresCall)
        return this.inner.CreateIdentityStores(identityRoot, masterKey)
    }

    public CreateTenantConfigStore(configRoot: string): Promise<ITenantConfigStore>
    {
        this.calls.push(RecordingPlatform.TenantConfigCall)
        return this.inner.CreateTenantConfigStore(configRoot)
    }
}

class InjectionFixture
{
    public static Base(): string
    {
        return mkdtempSync(join(tmpdir(), 'inject-'))
    }

    public static KeyFile(dir: string): string
    {
        const path = join(dir, 'master.key')
        writeFileSync(path, Buffer.alloc(32, 5))
        return path
    }
}

test('a server built with an injected platform routes all infra + identity through it', async () =>
{
    const base = InjectionFixture.Base()
    const platform = new RecordingPlatform()
    const server = new PragmaticServer({
        packagesRoot: join(base, 'packages'),
        platform,
        identity: {
            identityRoot: join(base, 'identity'),
            masterKey: { keyFilePath: InjectionFixture.KeyFile(base) },
            tenant: { id: 't1', displayName: 'T1' },
        },
    })
    await server.Start()
    try
    {
        assert.ok(platform.calls.includes(RecordingPlatform.RegistryCall))
        assert.ok(platform.calls.includes(RecordingPlatform.PackagesCall))
        assert.ok(platform.calls.includes(RecordingPlatform.PromptCall))
        assert.ok(platform.calls.includes(RecordingPlatform.MasterKeyCall))
        assert.ok(platform.calls.includes(RecordingPlatform.IdentityStoresCall))
        assert.ok(platform.calls.includes(RecordingPlatform.TenantConfigCall))
        assert.notEqual(await server.Pack(), undefined)
    }
    finally
    {
        await server.Dispose()
    }
})
