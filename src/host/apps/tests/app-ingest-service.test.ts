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
import { StructuredLogger } from '../../../observability/logger.js'
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
        const result = await fx.Service.Ingest(IngestFixture.Params())
        assert.equal(result.status, AppWriteStatus.Applied)
        assert.equal(result.reason, undefined)
        assert.ok(existsSync(join(fx.PackagesDir, 'shop.core', '1.0.0', 'model.json')))
        assert.ok(existsSync(join(fx.PackagesDir, 'shop.base', '2.0.0', 'model.json')))
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', '1.0.0', 'ui', 'assets', 'app.js'), 'utf8'), IngestFixture.Secret)
        assert.equal(fx.Apps.Renamed[fx.Apps.Renamed.length - 1], 'shop/1.0.0/application.json')
        assert.ok(fx.Apps.Renamed.indexOf('shop/1.0.0/ui/index.html') < fx.Apps.Renamed.length - 1)
        assert.deepEqual(readdirSync(join(fx.AppsDir, 'shop')).sort(), ['1.0.0', 'live'])
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
        const result = await fx.Service.Ingest(params)
        assert.notEqual(result.status, AppWriteStatus.Applied)
        assert.match(result.reason ?? '', /shop\.base@2\.0\.0/)
        assert.equal(existsSync(join(fx.AppsDir, 'shop', '1.0.0', 'application.json')), false)
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
        const result = await fx.Service.Ingest(params)
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
        p => { p.uiBundle[0]!.path = 'a/.../b.js' },
        p => { p.uiBundle[0]!.path = '.git/config' },
        p => { p.uiBundle[0]!.path = 'CON' },
        p => { p.uiBundle[0]!.path = 'x/nul.txt' },
        p => { p.uiBundle[0]!.path = 'trailing.' },
        p => { p.uiBundle[0]!.path = 'trailing ' },
        p => { p.uiBundle[0]!.contentBase64 = '' },
        p => { p.packages[1]!.id = 'COM1' },
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
            const result = await fx.Service.Ingest(params)
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

class FailingStorage extends RecordingStorage
{
    public FailRenameTo = ''

    public override async Rename(from: string, to: string): Promise<void>
    {
        if (to === this.FailRenameTo)
        {
            throw new Error('boom ' + IngestFixture.Secret)
        }
        await super.Rename(from, to)
    }
}

test('redeploying an existing name@version is refused and leaves the live app untouched', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        const before = readFileSync(join(fx.AppsDir, 'shop', '1.0.0', 'application.json'), 'utf8')
        const again = IngestFixture.Params()
        again.uiBundle[0]!.contentBase64 = Buffer.from('<html>changed</html>').toString('base64')
        const result = await fx.Service.Ingest(again)
        assert.equal(result.status, AppWriteStatus.Conflict)
        assert.match(result.reason ?? '', /immutable/)
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', '1.0.0', 'application.json'), 'utf8'), before)
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', '1.0.0', 'ui', 'index.html'), 'utf8'), '<html></html>')
    })
})

test('a package version already deployed with different content is refused', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        const next = IngestFixture.Params()
        next.appVersion = '2.0.0'
        next.manifest.version = '2.0.0'
        next.packages[1]!.modelJson = '{"changed":true}'
        const result = await fx.Service.Ingest(next)
        assert.equal(result.status, AppWriteStatus.Conflict)
        assert.equal(readFileSync(join(fx.PackagesDir, 'shop.base', '2.0.0', 'model.json'), 'utf8'), '{}')
    })
})

test('an invalidation failure after the marker landed does not flip the deploy to Failed', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const throwing: IAppCacheInvalidator = { InvalidateApp: () => { throw new Error('evict failed') } }
        const service = new AppIngestService(fx.Packages, fx.Apps, throwing)
        const result = await service.Ingest(IngestFixture.Params())
        assert.equal(result.status, AppWriteStatus.Applied)
        assert.ok(existsSync(join(fx.AppsDir, 'shop', '1.0.0', 'application.json')))
    })
})

test('a failure during commit removes renamed files, logs only class/code, and keeps the reason secret-free', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const apps = new FailingStorage(fx.AppsDir)
        apps.FailRenameTo = 'shop/1.0.0/application.json'
        const lines: string[] = []
        const logger = StructuredLogger.ToSink(line => lines.push(line))
        const service = new AppIngestService(fx.Packages, apps, fx.Invalidator, logger)
        const result = await service.Ingest(IngestFixture.Params())
        assert.equal(result.status, AppWriteStatus.Failed)
        assert.equal(JSON.stringify(result).includes(IngestFixture.Secret), false)
        assert.equal(lines.join('').includes(IngestFixture.Secret), false)
        assert.match(lines.join(''), /"errorClass":"Error"/)
        assert.equal(existsSync(join(fx.AppsDir, 'shop', '1.0.0', 'application.json')), false)
        assert.equal(existsSync(join(fx.AppsDir, 'shop', '1.0.0', 'ui', 'index.html')), false)
        assert.deepEqual(readdirSync(join(fx.AppsDir, 'shop', '1.0.0', 'ui')).filter(n => n.includes('.ingest-')), [])
        assert.deepEqual(fx.Invalidator.Keys, [])
    })
})

test('a bundle asset named like a temp file does not collide with staging', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const params = IngestFixture.Params()
        params.uiBundle.push({ path: 'assets/app.js.ingest-tmp', contentBase64: Buffer.from('x').toString('base64') })
        const result = await fx.Service.Ingest(params)
        assert.equal(result.status, AppWriteStatus.Applied)
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', '1.0.0', 'ui', 'assets', 'app.js'), 'utf8'), IngestFixture.Secret)
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', '1.0.0', 'ui', 'assets', 'app.js.ingest-tmp'), 'utf8'), 'x')
    })
})

test('a multi-megabyte UI asset is accepted (base64 validation scales past the regex stack limit)', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const largeBytes = 8 * 1024 * 1024
        const params = IngestFixture.Params()
        params.uiBundle[0]!.contentBase64 = Buffer.alloc(largeBytes, 0x61).toString('base64')
        const result = await fx.Service.Ingest(params)
        assert.equal(result.status, AppWriteStatus.Applied)
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', '1.0.0', 'ui', IngestFixture.Entry)).length, largeBytes)
    })
})

test('a UI asset whose length is not a base64 multiple of four is rejected', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const params = IngestFixture.Params()
        params.uiBundle[0]!.contentBase64 = 'QUJD'.slice(0, 3)
        const result = await fx.Service.Ingest(params)
        assert.equal(result.status, AppWriteStatus.Invalid)
    })
})

test('concurrent deploys of the same app serialize: exactly one is Applied, the other is a Conflict', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const results = await Promise.all([fx.Service.Ingest(IngestFixture.Params()), fx.Service.Ingest(IngestFixture.Params())])
        assert.deepEqual(results.map(r => r.status).sort(), [AppWriteStatus.Applied, AppWriteStatus.Conflict])
    })
})

test('only a whitelisted manifest projection is persisted', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const params = IngestFixture.Params()
        ;(params.manifest as unknown as Record<string, unknown>).evil = 'x'
        ;(params.manifest.packages[0] as unknown as Record<string, unknown>).extra = 'y'
        await fx.Service.Ingest(params)
        const stored = JSON.parse(readFileSync(join(fx.AppsDir, 'shop', '1.0.0', 'application.json'), 'utf8'))
        assert.deepEqual(stored, {
            name: 'shop', version: '1.0.0', packages: [{ id: 'shop.core', version: '1.0.0' }],
            ui: { entry: 'index.html', assets: ['assets/app.js'] },
        })
    })
})

test('a mid-commit failure of a later version leaves the earlier version tree and the live pointer untouched', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        const apps = new FailingStorage(fx.AppsDir)
        apps.FailRenameTo = 'shop/2.0.0/application.json'
        const service = new AppIngestService(fx.Packages, apps, fx.Invalidator)
        const next = IngestFixture.Params()
        next.appVersion = '2.0.0'
        next.manifest.version = '2.0.0'
        next.uiBundle.push({ path: 'extra.js', contentBase64: Buffer.from('n').toString('base64') })
        const result = await service.Ingest(next)
        assert.equal(result.status, AppWriteStatus.Failed)
        assert.ok(existsSync(join(fx.AppsDir, 'shop', '1.0.0', 'ui', 'index.html')))
        assert.ok(existsSync(join(fx.AppsDir, 'shop', '1.0.0', 'ui', 'assets', 'app.js')))
        assert.equal(existsSync(join(fx.AppsDir, 'shop', '2.0.0', 'application.json')), false)
        assert.equal(existsSync(join(fx.AppsDir, 'shop', '2.0.0', 'ui', 'extra.js')), false)
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', 'live'), 'utf8'), '1.0.0')
        assert.equal(JSON.parse(readFileSync(join(fx.AppsDir, 'shop', '1.0.0', 'application.json'), 'utf8')).version, '1.0.0')
    })
})

test('Ingest writes UI under <app>/<version>/ui and the manifest under <app>/<version>/application.json', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', '1.0.0', 'ui', 'index.html'), 'utf8'), '<html></html>')
        assert.equal(JSON.parse(readFileSync(join(fx.AppsDir, 'shop', '1.0.0', 'application.json'), 'utf8')).version, '1.0.0')
        assert.equal(existsSync(join(fx.AppsDir, 'shop', 'ui')), false)
        assert.equal(existsSync(join(fx.AppsDir, 'shop', 'application.json')), false)
    })
})

class OrderingStorage extends RecordingStorage
{
    public readonly Order: string[] = []

    public override async Rename(from: string, to: string): Promise<void>
    {
        await super.Rename(from, to)
        this.Order.push(to)
    }

    public override async WriteText(path: string, text: string): Promise<void>
    {
        await super.WriteText(path, text)
        this.Order.push(path)
    }
}

test('Ingest writes a <app>/live pointer naming the deployed version, written after the version tree', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const apps = new OrderingStorage(fx.AppsDir)
        const service = new AppIngestService(fx.Packages, apps, fx.Invalidator)
        assert.equal((await service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', 'live'), 'utf8'), '1.0.0')
        assert.equal(apps.Order[apps.Order.length - 1], 'shop/live')
        assert.equal(apps.Order[apps.Order.length - 2], 'shop/1.0.0/application.json')
    })
})

test('deploying a second version leaves the first version tree intact and repoints <app>/live', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        const next = IngestFixture.Params()
        next.appVersion = '2.0.0'
        next.manifest.version = '2.0.0'
        next.uiBundle[0]!.contentBase64 = Buffer.from('<html>v2</html>').toString('base64')
        assert.equal((await fx.Service.Ingest(next)).status, AppWriteStatus.Applied)
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', '1.0.0', 'ui', 'index.html'), 'utf8'), '<html></html>')
        assert.equal(JSON.parse(readFileSync(join(fx.AppsDir, 'shop', '1.0.0', 'application.json'), 'utf8')).version, '1.0.0')
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', '2.0.0', 'ui', 'index.html'), 'utf8'), '<html>v2</html>')
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', 'live'), 'utf8'), '2.0.0')
        assert.equal((await new PragmaticAppsRegistry(fx.Apps).ApplicationFor('shop')).Manifest.version, '2.0.0')
    })
})

test('the reserved version names live and ui are rejected', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        for (const reserved of ['live', 'ui', 'application.json'])
        {
            const params = IngestFixture.Params()
            params.appVersion = reserved
            params.manifest.version = reserved
            const result = await fx.Service.Ingest(params)
            assert.equal(result.status, AppWriteStatus.Invalid)
            assert.match(result.reason ?? '', /reserved/)
        }
        assert.equal(existsSync(join(fx.AppsDir, 'shop')), false)
    })
})

class PointerFailingStorage extends RecordingStorage
{
    public FailPointer = true

    public override async WriteText(path: string, text: string): Promise<void>
    {
        if (this.FailPointer && path === 'shop/live')
        {
            throw new Error('pointer boom')
        }
        await super.WriteText(path, text)
    }
}

test('a same-version retry after a failed live-pointer write resumes by writing only the pointer', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const apps = new PointerFailingStorage(fx.AppsDir)
        const service = new AppIngestService(fx.Packages, apps, fx.Invalidator)
        assert.equal((await service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Failed)
        assert.ok(existsSync(join(fx.AppsDir, 'shop', '1.0.0', 'application.json')))
        assert.equal(existsSync(join(fx.AppsDir, 'shop', 'live')), false)
        apps.FailPointer = false
        assert.equal((await service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', 'live'), 'utf8'), '1.0.0')
        assert.equal((await service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Conflict)
    })
})

test('re-deploying an existing non-live version with identical UI and manifest but a differing package is a Conflict', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        const next = IngestFixture.Params()
        next.appVersion = '2.0.0'
        next.manifest.version = '2.0.0'
        assert.equal((await fx.Service.Ingest(next)).status, AppWriteStatus.Applied)
        const differingPackage = IngestFixture.Params()
        differingPackage.packages[1]!.modelJson = '{"changed":true}'
        assert.equal((await fx.Service.Ingest(differingPackage)).status, AppWriteStatus.Conflict)
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', 'live'), 'utf8'), '2.0.0')
    })
})

test('re-deploying an existing non-live version is a Conflict when the content differs and a repoint when identical', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        const next = IngestFixture.Params()
        next.appVersion = '2.0.0'
        next.manifest.version = '2.0.0'
        assert.equal((await fx.Service.Ingest(next)).status, AppWriteStatus.Applied)
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', 'live'), 'utf8'), '2.0.0')
        const differing = IngestFixture.Params()
        differing.uiBundle[0]!.contentBase64 = Buffer.from('<html>changed</html>').toString('base64')
        assert.equal((await fx.Service.Ingest(differing)).status, AppWriteStatus.Conflict)
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', 'live'), 'utf8'), '2.0.0')
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', '1.0.0', 'ui', 'index.html'), 'utf8'), '<html></html>')
        const differingManifest = IngestFixture.Params()
        differingManifest.manifest.packages = []
        assert.equal((await fx.Service.Ingest(differingManifest)).status, AppWriteStatus.Conflict)
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', 'live'), 'utf8'), '1.0.0')
    })
})
