import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NpmAdapterPackProvider, NpmCli, WorkerThreadSandboxFactory } from '@pragmatic-tech-ai/todl-connectors-host'
import type { INpmCli } from '@pragmatic-tech-ai/todl-connectors-host'
import { PragmaticServer } from '../pragmatic-server.js'

/** Opt-in gate for the real-npm / fake-registry e2e (mirrors TCH's PACK_INSTALLER_IT). */
class Gate
{
    private static readonly Var = 'PACK_E2E'
    private static readonly On = '1'

    public static get Enabled(): boolean
    {
        return process.env[Gate.Var] === Gate.On
    }
}

/** Reference pack location, solution authoring, and the shared assertion. */
class PackE2E
{
    public static readonly PackName = '@pragmatic-tech-ai/adapter-pack-example'
    private static readonly FixtureRelative = '../../../todl-connectors-host/fixtures/adapter-pack-example'
    private static readonly Utf8 = 'utf8'
    private static readonly DirPrefix = 'plan9t5-'
    private static readonly PackageJson = 'package.json'
    private static readonly DistDir = 'dist'
    private static readonly NodeModules = 'node_modules'
    private static readonly WidgetsSource = 'widgets'
    private static readonly WidgetConcept = 'shop.Widget'
    private static readonly SolutionFile = 'Sample.pksln'
    private static readonly ModelsDir = 'models'
    private static readonly ProjectFile = 'project.plexus'
    private static readonly ModelFile = 'model.todl'
    private static readonly NameField = 'name'
    private static readonly Alpha = 'alpha'
    private static readonly Beta = 'beta'

    public static get FixtureDir(): string
    {
        return resolve(fileURLToPath(new URL('.', import.meta.url)), PackE2E.FixtureRelative)
    }

    public static FixtureManifest(): Record<string, unknown>
    {
        return JSON.parse(readFileSync(join(PackE2E.FixtureDir, PackE2E.PackageJson), PackE2E.Utf8)) as Record<string, unknown>
    }

    public static FixtureVersion(): string
    {
        return PackE2E.FixtureManifest()['version'] as string
    }

    public static MakeTempDir(): string
    {
        return mkdtempSync(join(tmpdir(), PackE2E.DirPrefix))
    }

    /** Copies the BUILT reference pack (manifest + dist) into `<root>/node_modules/<name>`. */
    public static SeedBuiltPack(root: string): void
    {
        const dest = join(root, PackE2E.NodeModules, PackE2E.PackName)
        mkdirSync(dest, { recursive: true })
        cpSync(join(PackE2E.FixtureDir, PackE2E.PackageJson), join(dest, PackE2E.PackageJson))
        cpSync(join(PackE2E.FixtureDir, PackE2E.DistDir), join(dest, PackE2E.DistDir), { recursive: true })
    }

    /** Authors an on-disk solution whose datasource declares `provider = "<spec>"` (kind sql). */
    public static WriteSolution(dir: string, providerSpec: string): void
    {
        const todl = `
namespace shop {
  concept Widget { name : string; }
  datasource ext { kind = sql; provider = "${providerSpec}"; }
  model Shop : shop {
    annotate entrypoint { }
    connect ext;
    populate Widget from ext.widgets key id { name = "name"; }
  }
}
`
        writeFileSync(join(dir, PackE2E.SolutionFile), JSON.stringify({ kind: 'todl-solution', version: 1, name: 'Sample', members: [{ path: PackE2E.ModelsDir, type: 'meta-model' }], settings: {}, bags: {} }))
        mkdirSync(join(dir, PackE2E.ModelsDir), { recursive: true })
        writeFileSync(join(dir, PackE2E.ModelsDir, PackE2E.ProjectFile), JSON.stringify({ type: 'meta-model', name: 'Shop Model', id: 'shop-model', packageVersion: '0.1.0' }))
        writeFileSync(join(dir, PackE2E.ModelsDir, PackE2E.ModelFile), todl)
    }

    /** Opens the solution, reads Widgets through the provider-resolved adapter, asserts the pack's seeded rows. */
    public static async AssertSeededRows(server: PragmaticServer, dir: string): Promise<void>
    {
        await server.Start()
        await server.OpenSolution(dir)
        const runtime = await server.Connectors()
        const models = runtime.ModelsWithConnectors()
        assert.equal(models.length, 1)
        assert.equal(models[0]!.Bindings[0]!.Source, PackE2E.WidgetsSource)
        const entities = await runtime.ReadEntities(models[0]!.ModelId, PackE2E.WidgetConcept)
        const names = entities.map(e => String((e.Snapshot() as Record<string, unknown>)[PackE2E.NameField])).sort()
        assert.deepEqual(names, [PackE2E.Alpha, PackE2E.Beta])
    }
}

/** Installs by copying the built reference pack and pinning a lockfile: no network. */
class FakeNpm implements INpmCli
{
    public Installs = 0

    public async Install(cwd: string): Promise<void>
    {
        this.Installs++
        PackE2E.SeedBuiltPack(cwd)
        const lock = { lockfileVersion: 3, packages: { [`node_modules/${PackE2E.PackName}`]: { version: PackE2E.FixtureVersion() } } }
        writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lock))
    }

    public async AuditSignatures(_cwd: string): Promise<void>
    {
    }
}

/** Minimal in-process npm registry serving one packument + its tarball. */
class FakeRegistry
{
    private static readonly Host = '127.0.0.1'
    private static readonly JsonType = { 'content-type': 'application/json' }
    private static readonly BinaryType = { 'content-type': 'application/octet-stream' }

    private readonly http: Server
    private port = 0

    public constructor(private readonly name: string, private readonly version: string, private readonly manifest: Record<string, unknown>, private readonly tarball: Buffer)
    {
        this.http = createServer((req, res) => this.Handle(req.url ?? '', res))
    }

    public get Url(): string
    {
        return `http://${FakeRegistry.Host}:${this.port}`
    }

    public async Start(): Promise<void>
    {
        await new Promise<void>(ok => this.http.listen(0, FakeRegistry.Host, ok))
        this.port = (this.http.address() as AddressInfo).port
    }

    public async Stop(): Promise<void>
    {
        this.http.closeAllConnections()
        await new Promise<void>(ok => this.http.close(() => ok()))
    }

    private Handle(url: string, res: ServerResponse): void
    {
        const path = decodeURIComponent(url.split('?')[0]!)
        const tarPath = `/tarballs/${this.version}.tgz`
        if (path === tarPath)
        {
            res.writeHead(200, FakeRegistry.BinaryType)
            res.end(this.tarball)
            return
        }
        if (path === `/${this.name}`)
        {
            const integrity = `sha512-${createHash('sha512').update(this.tarball).digest('base64')}`
            const shasum = createHash('sha1').update(this.tarball).digest('hex')
            const version = { ...this.manifest, name: this.name, version: this.version, dist: { tarball: `${this.Url}${tarPath}`, integrity, shasum } }
            const packument = { name: this.name, 'dist-tags': { latest: this.version }, versions: { [this.version]: version } }
            res.writeHead(200, FakeRegistry.JsonType)
            res.end(JSON.stringify(packument))
            return
        }
        res.writeHead(404)
        res.end()
    }
}

/** Sets env vars for a scope and restores the prior values. */
class EnvScope
{
    private readonly saved = new Map<string, string | undefined>()

    public Set(key: string, value: string): void
    {
        if (!this.saved.has(key))
        {
            this.saved.set(key, process.env[key])
        }
        process.env[key] = value
    }

    public Restore(): void
    {
        for (const [key, value] of this.saved)
        {
            if (value === undefined)
            {
                delete process.env[key]
            }
            else
            {
                process.env[key] = value
            }
        }
        this.saved.clear()
    }
}

test('a provider-declared connector resolves through the composed server and the real worker sandbox', async () =>
{
    const work = PackE2E.MakeTempDir()
    const solution = join(work, 'solution')
    mkdirSync(solution)
    PackE2E.WriteSolution(solution, `${PackE2E.PackName}@*`)
    const npm = new FakeNpm()
    const provider = new NpmAdapterPackProvider({
        cacheDir: join(work, 'cache'),
        npm,
        sandboxFactory: new WorkerThreadSandboxFactory(),
        allowProviderOverride: true,
        providerAllowlist: [PackE2E.PackName],
    })
    const server = new PragmaticServer({ packagesRoot: join(work, 'packages'), connectors: { provider } })
    try
    {
        await PackE2E.AssertSeededRows(server, solution)
        assert.equal(npm.Installs, 1)
    }
    finally
    {
        await server.Dispose()
        rmSync(work, { recursive: true, force: true })
    }
})

test('a provider-declared connector installs from a fake registry with real npm and resolves rows', { skip: !Gate.Enabled, timeout: 300000 }, async () =>
{
    const work = PackE2E.MakeTempDir()
    const solution = join(work, 'solution')
    mkdirSync(solution)
    const env = new EnvScope()
    let registry: FakeRegistry | undefined
    let server: PragmaticServer | undefined
    try
    {
        const shell = process.platform === 'win32'
        const packOut = execFileSync('npm', ['pack', '--pack-destination', work], { cwd: PackE2E.FixtureDir, encoding: 'utf8', shell }).trim().split(/\r?\n/)
        const tarball = readFileSync(join(work, packOut[packOut.length - 1]!.trim()))
        const version = PackE2E.FixtureVersion()
        registry = new FakeRegistry(PackE2E.PackName, version, PackE2E.FixtureManifest(), tarball)
        await registry.Start()
        env.Set('npm_config_registry', registry.Url)
        env.Set('npm_config_@pragmatic-tech-ai:registry', registry.Url)
        env.Set('npm_config_cache', join(work, 'npm-cache'))
        PackE2E.WriteSolution(solution, `${PackE2E.PackName}@^${version}`)
        const provider = new NpmAdapterPackProvider({
            cacheDir: join(work, 'cache'),
            npm: new NpmCli(),
            sandboxFactory: new WorkerThreadSandboxFactory(),
            allowProviderOverride: true,
            providerAllowlist: [PackE2E.PackName],
        })
        server = new PragmaticServer({ packagesRoot: join(work, 'packages'), connectors: { provider } })
        await PackE2E.AssertSeededRows(server, solution)
        assert.ok(existsSync(join(work, 'cache')))
    }
    finally
    {
        await server?.Dispose()
        await registry?.Stop()
        env.Restore()
        rmSync(work, { recursive: true, force: true })
    }
})
