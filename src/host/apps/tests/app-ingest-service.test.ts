import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { InMemoryMessageSocket, PragmaticClient, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherAppDeployParamsDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { AppIngestService } from '../app-ingest-service.js'
import type { IAppCacheInvalidator } from '../app-ingest-service.js'
import { PragmaticAppsRegistry } from '../pragmatic-apps-registry.js'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import { ServerConnectionHandler } from '../../server-connection-handler.js'

class RecordingStorage extends NodeFsStorage
{
    public readonly Renamed: string[] = []

    public override async Rename(from: string, to: string): Promise<void>
    {
        this.Renamed.push(to)
        await super.Rename(from, to)
    }
}

class RecordingInvalidator implements IAppCacheInvalidator
{
    public readonly Keys: string[] = []

    public InvalidateApp(nameAtVersion: string): void
    {
        this.Keys.push(nameAtVersion)
    }
}

class IngestFixture
{
    public static readonly App = 'shop'
    public static readonly Version = '1.0.0'
    public static readonly Entry = 'index.html'
    public static readonly Asset = 'assets/app.js'
    public static readonly ManifestFile = 'application.json'
    public static readonly Secret = 'SECRET-PAYLOAD-BYTES'
    public static readonly TenantId = 't1'

    public readonly Root = mkdtempSync(join(tmpdir(), 'ingest-'))
    public readonly PackagesDir = join(this.Root, 'packages')
    public readonly AppsDir = join(this.Root, 'applications')
    public readonly Packages = new RecordingStorage(this.PackagesDir)
    public readonly Apps = new RecordingStorage(this.AppsDir)
    public readonly Invalidator = new RecordingInvalidator()
    public readonly Service = new AppIngestService(this.Packages, this.Apps, this.Invalidator)

    public static Tenant(): Tenant
    {
        return new Tenant(IngestFixture.TenantId, TenantKind.SelfHosted, 'Tenant One')
    }

    public static Context(role: Role): AccessContext
    {
        const principal = new Principal('p1', IngestFixture.TenantId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', role, new ResourceRef(ResourceKind.Tenant, IngestFixture.TenantId, []))]
        return new AccessContext(principal, IngestFixture.Tenant(), grants, new ResourceAuthorizationPolicy())
    }

    public static Params(): CypherAppDeployParamsDto
    {
        return {
            appName: IngestFixture.App,
            appVersion: IngestFixture.Version,
            packages: [
                { id: 'shop.core', version: '1.0.0', modelJson: '{"dependencies":[{"id":"shop.base","version":"2.0.0"}]}' },
                { id: 'shop.base', version: '2.0.0', modelJson: '{}' },
            ],
            uiBundle: [
                { path: IngestFixture.Entry, contentBase64: Buffer.from('<html></html>').toString('base64') },
                { path: IngestFixture.Asset, contentBase64: Buffer.from(IngestFixture.Secret).toString('base64') },
            ],
            manifest: {
                name: IngestFixture.App,
                version: IngestFixture.Version,
                packages: [{ id: 'shop.core', version: '1.0.0' }],
                ui: { entry: IngestFixture.Entry, assets: [IngestFixture.Asset] },
            },
        }
    }

    public Dispose(): void
    {
        rmSync(this.Root, { recursive: true, force: true })
    }

    public static async Run(body: (fx: IngestFixture) => Promise<void>): Promise<void>
    {
        const fx = new IngestFixture()
        try
        {
            await body(fx)
        }
        finally
        {
            fx.Dispose()
        }
    }
}

test('a valid deploy writes packages, UI assets and application.json last, and the registry loads it', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const result = await fx.Service.Ingest(IngestFixture.Tenant(), IngestFixture.Params())
        assert.equal(result.status, AppWriteStatus.Applied)
        assert.equal(result.reason, undefined)
        assert.ok(existsSync(join(fx.PackagesDir, 'shop.core', '1.0.0', 'model.json')))
        assert.ok(existsSync(join(fx.PackagesDir, 'shop.base', '2.0.0', 'model.json')))
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', 'ui', 'assets', 'app.js'), 'utf8'), IngestFixture.Secret)
        assert.equal(fx.Apps.Renamed[fx.Apps.Renamed.length - 1], 'shop/application.json')
        assert.ok(fx.Apps.Renamed.indexOf('shop/ui/index.html') < fx.Apps.Renamed.length - 1)
        assert.deepEqual(readdirSync(join(fx.AppsDir, 'shop')).sort(), ['application.json', 'ui'])
        const app = await new PragmaticAppsRegistry(fx.Apps).ApplicationFor('shop')
        assert.equal(app.Manifest.version, '1.0.0')
        assert.deepEqual(fx.Invalidator.Keys, ['shop@1.0.0'])
    })
})

test('an incomplete package closure is rejected and nothing servable is written', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const params = IngestFixture.Params()
        params.packages = params.packages.filter(p => p.id !== 'shop.base')
        const result = await fx.Service.Ingest(IngestFixture.Tenant(), params)
        assert.notEqual(result.status, AppWriteStatus.Applied)
        assert.match(result.reason ?? '', /shop\.base@2\.0\.0/)
        assert.equal(existsSync(join(fx.AppsDir, 'shop', 'application.json')), false)
        assert.equal(existsSync(join(fx.AppsDir, 'shop')), false)
        assert.equal(existsSync(join(fx.PackagesDir)), false)
        assert.deepEqual(fx.Invalidator.Keys, [])
    })
})

test('a manifest-referenced package that is not supplied is rejected', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const params = IngestFixture.Params()
        params.manifest.packages.push({ id: 'ghost', version: '1.0.0' })
        const result = await fx.Service.Ingest(IngestFixture.Tenant(), params)
        assert.notEqual(result.status, AppWriteStatus.Applied)
        assert.match(result.reason ?? '', /ghost@1\.0\.0/)
    })
})

test('path traversal in UI paths, package ids and app name is rejected without leaking payload bytes', async () =>
{
    const mutations: Array<(p: CypherAppDeployParamsDto) => void> = [
        p => { p.uiBundle[0]!.path = '../evil.js' },
        p => { p.uiBundle[0]!.path = 'a/../../evil.js' },
        p => { p.uiBundle[0]!.path = '/etc/passwd' },
        p => { p.uiBundle[0]!.path = 'C:/evil.js' },
        p => { p.uiBundle[0]!.path = 'a\\..\\evil.js' },
        p => { p.packages[1]!.id = '..' },
        p => { p.packages[1]!.id = '../x' },
        p => { p.packages[1]!.version = 'C:' },
        p => { p.appName = '..' },
        p => { p.appName = 'a/b' },
    ]
    for (const mutate of mutations)
    {
        await IngestFixture.Run(async fx =>
        {
            const params = IngestFixture.Params()
            mutate(params)
            const result = await fx.Service.Ingest(IngestFixture.Tenant(), params)
            assert.equal(result.status, AppWriteStatus.Invalid)
            assert.equal((result.reason ?? '').includes(IngestFixture.Secret), false)
            assert.equal(existsSync(fx.PackagesDir), false)
            assert.equal(existsSync(fx.AppsDir), false)
            assert.equal(existsSync(join(fx.Root, 'evil.js')), false)
        })
    }
})

test('InvalidateApp evicts a cached app graph entry', async () =>
{
    const server = new PragmaticServer({ packagesRoot: join(tmpdir(), 'unused-pkgs'), applicationsRoot: join(tmpdir(), 'unused-apps'), purpose: TenantPurpose.Runtime })
    const cache = (server as unknown as { appGraphs: Map<string, Promise<unknown>> }).appGraphs
    cache.set('shop@1.0.0', Promise.resolve({}))
    cache.set('shop@2.0.0', Promise.resolve({}))
    server.InvalidateApp('shop@1.0.0')
    assert.equal(cache.has('shop@1.0.0'), false)
    assert.equal(cache.has('shop@2.0.0'), true)
})

class DeployWire
{
    public static async Attach(fx: IngestFixture, role: Role): Promise<{ client: PragmaticClient; Dispose: () => Promise<void> }>
    {
        const server = new PragmaticServer({ packagesRoot: fx.PackagesDir, applicationsRoot: fx.AppsDir, purpose: TenantPurpose.Runtime })
        await server.Start()
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const runtime = ServerConnectionHandler.RuntimeAttachArgs(server)
        const handler = ServerConnectionHandler.Attach(
            serverSocket, languageService, manager, IngestFixture.Context(role),
            () => Promise.reject(new Error('no connectors')), ctx => server.Graph(ctx),
            undefined, undefined, undefined, undefined, undefined, undefined, TenantPurpose.Runtime,
            runtime.applications, runtime.appGraphProvider, runtime.appWriteProvider, runtime.shareProvider, runtime.unshareProvider, runtime.listSharesProvider, runtime.assignProvider,
            undefined, undefined, undefined, undefined, undefined, undefined, runtime.deployProvider)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        return {
            client,
            Dispose: async () =>
            {
                await client.DisposeAsync()
                handler.Dispose()
                await server.Dispose()
            },
        }
    }
}

test('RunDeploy denies a principal without tenant Administer and writes nothing', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const wire = await DeployWire.Attach(fx, Role.Editor)
        try
        {
            await assert.rejects(() => wire.client.DeployApplication(IngestFixture.Params()))
            assert.equal(existsSync(join(fx.AppsDir, 'shop')), false)
        }
        finally
        {
            await wire.Dispose()
        }
    })
})

test('RunDeploy lets an Admin deploy and the app is then listed', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const wire = await DeployWire.Attach(fx, Role.Admin)
        try
        {
            const result = await wire.client.DeployApplication(IngestFixture.Params())
            assert.equal(result.status, AppWriteStatus.Applied)
            const apps = await wire.client.ListApplications()
            assert.ok(apps.some(a => a.name === 'shop' && a.version === '1.0.0'))
        }
        finally
        {
            await wire.Dispose()
        }
    })
})
