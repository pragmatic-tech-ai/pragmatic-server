import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDb } from 'pg-mem'
import { DataSourceKind } from '@pragmatic-tech-ai/todl'
import type { IDataSourceAdapterProvider } from '@pragmatic-tech-ai/todl'
import { NpmAdapterPackProvider, ChildProcessSandboxFactory, WorkerThreadSandboxFactory } from '@pragmatic-tech-ai/todl-connectors-host'
import type { INpmCli, NpmAdapterPackProviderOptions } from '@pragmatic-tech-ai/todl-connectors-host'
import { PragmaticServer } from '../../pragmatic-server.js'
import type { PragmaticServerOptions } from '../../pragmatic-server.js'
import { ConnectorsPolicy } from '../connector-policy.js'
import { SandboxStrategy } from '../../config/server-config.js'
import type { AdapterPacksConfig } from '../../config/server-config.js'
import { ServerConfigLoader } from '../../config/server-config-loader.js'

class CountingNpm implements INpmCli
{
    public Installs = 0

    public async Install(_cwd: string): Promise<void>
    {
        this.Installs++
    }

    public async AuditSignatures(_cwd: string): Promise<void>
    {
    }

    public async RunInstallScripts(_cwd: string): Promise<void>
    {
    }
}

class CountingSandboxFactory
{
    public Launches = 0

    public async Launch(): Promise<never>
    {
        this.Launches++
        throw new Error('unexpected launch')
    }
}

class RecordingProvider implements IDataSourceAdapterProvider
{
    public Disposed = false

    public async Resolve(): Promise<never>
    {
        throw new Error('recording provider resolve')
    }

    public async Dispose(): Promise<void>
    {
        this.Disposed = true
    }
}

class Fixture
{
    private static readonly DirPrefix = 'plan9t3-'
    private static readonly SolutionFile = 'Sample.pksln'
    private static readonly ModelsDir = 'models'
    private static readonly ProjectFile = 'project.plexus'
    private static readonly ModelFile = 'model.todl'
    private static readonly PackagesDir = 'packages'
    private static readonly ConceptId = 'shop.Customer'
    private static readonly CreateTable = 'CREATE TABLE "Customer" (customer_id text PRIMARY KEY, name text, description text, label text)'
    private static readonly InsertRow = `INSERT INTO "Customer" (customer_id, name) VALUES ('C1', 'Acme')`
    private static readonly PlainDatasource = 'kind = sql;'
    private static readonly ProviderDatasource = 'kind = sql; provider = "acme-pack@^1";'

    private static ModelTodl(datasourceBody: string): string
    {
        return `
namespace shop {
  concept Customer { name : string; }
  datasource pg { ${datasourceBody} database = "app"; }
  model Shop : shop {
    annotate entrypoint { }
    connect pg;
    populate Customer key customer_id { name = "name"; }
  }
}
`
    }

    private static SolutionDir(datasourceBody: string): string
    {
        const dir = mkdtempSync(join(tmpdir(), Fixture.DirPrefix))
        writeFileSync(join(dir, Fixture.SolutionFile), JSON.stringify({ kind: 'todl-solution', version: 1, name: 'Sample', members: [{ path: Fixture.ModelsDir, type: 'meta-model' }], settings: {}, bags: {} }))
        mkdirSync(join(dir, Fixture.ModelsDir), { recursive: true })
        writeFileSync(join(dir, Fixture.ModelsDir, Fixture.ProjectFile), JSON.stringify({ type: 'meta-model', name: 'Shop Model', id: 'shop-model', packageVersion: '0.1.0' }))
        writeFileSync(join(dir, Fixture.ModelsDir, Fixture.ModelFile), Fixture.ModelTodl(datasourceBody))
        return dir
    }

    private static Pool(): unknown
    {
        const db = newDb()
        db.public.none(Fixture.CreateTable)
        db.public.none(Fixture.InsertRow)
        return new (db.adapters.createPg()).Pool()
    }

    public static readonly AllowedPack = '@acme/allowed-pack'
    public static readonly OtherPack = '@acme/other-pack'
    public static readonly InstallReached = 'install reached'

    public static get Plain(): string
    {
        return Fixture.PlainDatasource
    }

    public static get Provider(): string
    {
        return Fixture.ProviderDatasource
    }

    public static BaseEnv(): Record<string, string | undefined>
    {
        return { PRAGMATIC_BASE_DIR: '/data', PRAGMATIC_MASTER_KEY_FILE: '/k', PRAGMATIC_TENANT_ID: 't1' }
    }

    public static TempDir(): string
    {
        return mkdtempSync(join(tmpdir(), Fixture.DirPrefix))
    }

    /** Opens the fixture solution on a server built from the options and runs the body against the connector runtime's read. */
    public static async WithServer(datasourceBody: string, extra: PragmaticServerOptions, body: (read: () => Promise<readonly unknown[]>) => Promise<void>): Promise<void>
    {
        const dir = Fixture.SolutionDir(datasourceBody)
        const pool = Fixture.Pool()
        const server = new PragmaticServer({ packagesRoot: join(dir, Fixture.PackagesDir), ...extra, connectors: { buildPool: () => pool as never, ...extra.connectors } })
        try
        {
            await server.Start()
            await server.OpenSolution(dir)
            const runtime = await server.Connectors()
            const models = runtime.ModelsWithConnectors()
            await body(async () => (await runtime.ReadEntities(models[0]!.ModelId, Fixture.ConceptId)).Entities)
        }
        finally
        {
            await server.Dispose()
            rmSync(dir, { recursive: true, force: true })
        }
    }

    public static Packs(cacheDir: string, strategy: SandboxStrategy = SandboxStrategy.Worker): AdapterPacksConfig
    {
        return { cacheDir, sandboxStrategy: strategy }
    }

    public static AdapterPackProvider(options: PragmaticServerOptions): IDataSourceAdapterProvider | undefined
    {
        return (PragmaticServer as unknown as { AdapterPackProvider(o: PragmaticServerOptions): IDataSourceAdapterProvider | undefined }).AdapterPackProvider(options)
    }
}

const Denied = new ConnectorsPolicy([DataSourceKind.Sql], false, false, [])

test('AdapterPackProvider builds a real NpmAdapterPackProvider from adapterPacks config', async () =>
{
    const cacheDir = Fixture.TempDir()
    try
    {
        for (const strategy of [SandboxStrategy.Worker, SandboxStrategy.Child])
        {
            const provider = Fixture.AdapterPackProvider({ adapterPacks: { ...Fixture.Packs(cacheDir, strategy), requireSignatures: true, resourceLimits: { maxOldGenerationSizeMb: 64 }, eviction: { maxVersionsPerPack: 2, maxAgeMs: 1000 } }, connectorsPolicy: Denied })
            assert.ok(provider instanceof NpmAdapterPackProvider)
            assert.equal(typeof provider.Resolve, 'function')
            const options = (provider as unknown as { options: NpmAdapterPackProviderOptions }).options
            const isChild = strategy === SandboxStrategy.Child
            assert.equal(options.sandboxFactory instanceof ChildProcessSandboxFactory, isChild)
            assert.equal(options.sandboxFactory instanceof WorkerThreadSandboxFactory, !isChild)
            assert.deepEqual(options.eviction, { MaxVersionsPerPack: 2, MaxAgeMs: 1000 })
            assert.deepEqual(options.sandboxOptions, { resourceLimits: { maxOldGenerationSizeMb: 64 } })
            assert.equal(options.requireSignatures, true)
            assert.equal(options.cacheDir, cacheDir)
            await provider.Dispose()
        }
    }
    finally
    {
        rmSync(cacheDir, { recursive: true, force: true })
    }
})

test('AdapterPackProvider positive path: override on and pack allowlisted passes the gate and reaches install', async () =>
{
    const cacheDir = Fixture.TempDir()
    try
    {
        const policy = new ConnectorsPolicy([DataSourceKind.Sql], false, true, [Fixture.AllowedPack])
        const provider = Fixture.AdapterPackProvider({ adapterPacks: Fixture.Packs(cacheDir), connectorsPolicy: policy }) as NpmAdapterPackProvider
        const reached = new Error(Fixture.InstallReached)
        const internals = provider as unknown as { installer: { Install(): Promise<never> } }
        internals.installer = { Install: async () => { throw reached } }
        await assert.rejects(provider.Resolve({ Provider: `${Fixture.AllowedPack}@1.0.0`, Kind: DataSourceKind.Sql } as never), (e: unknown) => e === reached)
        await assert.rejects(provider.Resolve({ Provider: `${Fixture.OtherPack}@1.0.0`, Kind: DataSourceKind.Sql } as never), /not allowlisted/)
        await provider.Dispose()
    }
    finally
    {
        rmSync(cacheDir, { recursive: true, force: true })
    }
})

test('loader: pack options without DIR are rejected with a typed message, DIR-less env stays feature-off', () =>
{
    assert.throws(() => ServerConfigLoader.Load({ ...Fixture.BaseEnv(), PRAGMATIC_ADAPTER_PACKS_MAX_OLD_MB: '64' }, () => '{}'), /require PRAGMATIC_ADAPTER_PACKS_DIR/)
    assert.throws(() => ServerConfigLoader.Load({ ...Fixture.BaseEnv(), PRAGMATIC_ADAPTER_PACKS_EVICT_MAX_VERSIONS: '2' }, () => '{}'), /require PRAGMATIC_ADAPTER_PACKS_DIR/)
    assert.equal(ServerConfigLoader.Load(Fixture.BaseEnv(), () => '{}').adapterPacks, undefined)
})

test('loader: the script allowlist env parses as trimmed csv names', () =>
{
    const env = { ...Fixture.BaseEnv(), PRAGMATIC_ADAPTER_PACKS_DIR: '/packs', PRAGMATIC_ADAPTER_PACKS_SCRIPT_ALLOWLIST: 'a, @scope/b ,,c' }
    assert.deepEqual(ServerConfigLoader.Load(env, () => '{}').adapterPacks?.scriptAllowlist, ['a', '@scope/b', 'c'])
})

test('loader: the script allowlist env without DIR is rejected', () =>
{
    assert.throws(() => ServerConfigLoader.Load({ ...Fixture.BaseEnv(), PRAGMATIC_ADAPTER_PACKS_SCRIPT_ALLOWLIST: 'a' }, () => '{}'), /require PRAGMATIC_ADAPTER_PACKS_DIR/)
})

test('AdapterPackProvider returns undefined when adapterPacks is absent', () =>
{
    assert.equal(Fixture.AdapterPackProvider({ connectorsPolicy: Denied }), undefined)
    assert.equal(Fixture.AdapterPackProvider({}), undefined)
})

test('loader: a bad sandbox strategy throws the typed config error', () =>
{
    const env = { PRAGMATIC_ADAPTER_PACKS_DIR: '/packs', PRAGMATIC_ADAPTER_PACKS_SANDBOX: 'vm' }
    assert.throws(() => ServerConfigLoader.Load({ ...Fixture.BaseEnv(), ...env }, () => '{}'), /PRAGMATIC_ADAPTER_PACKS_SANDBOX must be worker or child/)
})

test('loader: a well-formed adapter packs block loads with the enum value', () =>
{
    const env = {
        ...Fixture.BaseEnv(),
        PRAGMATIC_ADAPTER_PACKS_DIR: '/packs',
        PRAGMATIC_ADAPTER_PACKS_SANDBOX: 'child',
        PRAGMATIC_ADAPTER_PACKS_REQUIRE_SIGNATURES: 'true',
        PRAGMATIC_ADAPTER_PACKS_MAX_OLD_MB: '128',
        PRAGMATIC_ADAPTER_PACKS_EVICT_MAX_VERSIONS: '3',
    }
    const config = ServerConfigLoader.Load(env, () => '{}')
    assert.deepEqual(config.adapterPacks, {
        cacheDir: '/packs',
        sandboxStrategy: SandboxStrategy.Child,
        requireSignatures: true,
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: undefined, stackSizeMb: undefined },
        eviction: { maxVersionsPerPack: 3, maxAgeMs: undefined },
        scriptAllowlist: undefined,
    })
    assert.equal(ServerConfigLoader.Load(Fixture.BaseEnv(), () => '{}').adapterPacks, undefined)
    assert.equal(ServerConfigLoader.Load({ ...Fixture.BaseEnv(), PRAGMATIC_ADAPTER_PACKS_DIR: '/p' }, () => '{}').adapterPacks?.sandboxStrategy, SandboxStrategy.Worker)
})

test('gate through composition (config-built provider): override denied rejects a provider connector with no install', async () =>
{
    const cacheDir = Fixture.TempDir()
    try
    {
        await Fixture.WithServer(Fixture.Provider, { connectorsPolicy: Denied, adapterPacks: Fixture.Packs(cacheDir) }, async read =>
        {
            await assert.rejects(() => read(), /connector provider override is disabled by policy/)
        })
    }
    finally
    {
        rmSync(cacheDir, { recursive: true, force: true })
    }
})

test('gate through composition (injected provider): override denied runs no install and no launch', async () =>
{
    const cacheDir = Fixture.TempDir()
    const npm = new CountingNpm()
    const sandbox = new CountingSandboxFactory()
    const provider = new NpmAdapterPackProvider({ cacheDir, npm, sandboxFactory: sandbox as never, allowProviderOverride: false, providerAllowlist: ['acme-pack'] })
    try
    {
        await Fixture.WithServer(Fixture.Provider, { connectorsPolicy: Denied, connectors: { provider } }, async read =>
        {
            await assert.rejects(() => read(), /connector provider override is disabled by policy/)
        })
        assert.equal(npm.Installs, 0)
        assert.equal(sandbox.Launches, 0)
    }
    finally
    {
        rmSync(cacheDir, { recursive: true, force: true })
    }
})

test('allowlist gate: an override-enabled tenant still rejects a provider not on its allowlist before any install', async () =>
{
    const cacheDir = Fixture.TempDir()
    try
    {
        const policy = new ConnectorsPolicy([DataSourceKind.Sql], false, true, ['other-pack'])
        await Fixture.WithServer(Fixture.Provider, { connectorsPolicy: policy, adapterPacks: Fixture.Packs(cacheDir) }, async read =>
        {
            await assert.rejects(() => read(), /connector provider is not allowlisted/)
        })
    }
    finally
    {
        rmSync(cacheDir, { recursive: true, force: true })
    }
})

test('disposing the server disposes its provider through ConnectorsHost.Dispose', async () =>
{
    const provider = new RecordingProvider()
    const server = new PragmaticServer({ packagesRoot: join(Fixture.TempDir(), 'packages'), connectorsPolicy: Denied, connectors: { provider } })
    await server.Start()
    assert.equal(provider.Disposed, false)
    await server.Dispose()
    assert.equal(provider.Disposed, true)
})

test('feature off: a named-provider connector still gets the catalog no-provider rejection', async () =>
{
    await Fixture.WithServer(Fixture.Provider, { connectorsPolicy: Denied }, async read =>
    {
        await assert.rejects(() => read(), /no adapter provider is configured/)
    })
})

test('feature off: a non-provider connector is unchanged', async () =>
{
    await Fixture.WithServer(Fixture.Plain, { connectorsPolicy: ConnectorsPolicy.Default() }, async read =>
    {
        const entities = await read()
        assert.ok(entities.length >= 1)
    })
})

test('feature on: a non-provider connector still reads normally', async () =>
{
    const cacheDir = Fixture.TempDir()
    try
    {
        await Fixture.WithServer(Fixture.Plain, { connectorsPolicy: ConnectorsPolicy.Default(), adapterPacks: Fixture.Packs(cacheDir) }, async read =>
        {
            const entities = await read()
            assert.ok(entities.length >= 1)
        })
    }
    finally
    {
        rmSync(cacheDir, { recursive: true, force: true })
    }
})
