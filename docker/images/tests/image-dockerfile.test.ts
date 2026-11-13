import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo, Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IClosureEntry } from '../closure-check.js'
import { ControlPlaneRole, ControlPlaneRoles } from '../../../admin/control-plane/control-plane-role.js'
import { Template } from '../../../admin/control-plane/environment-record.js'
import { ReleaseTrustKeys } from '../../../admin/control-plane/release/release-trust-keys.js'
import { ControlPlaneServer } from '../../../admin/control-plane/server.js'
import { TemplateCatalog } from '../../../admin/control-plane/template-catalog.js'
import { TenantPlaneComposer } from '../../../admin/control-plane/tenant-plane-composer.js'
import { NorthwindApp } from '../../../environments/seed/compile.js'

/** docker/images/Dockerfile split into its stages (continuation lines joined), plus closure.json and the bake file. */
class ImageFiles
{
    public static readonly ServerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    public static readonly ServerDir = 'pragmatic-server/'
    public static readonly TenantAdminTree = 'dist-tenant-admin/'
    public static readonly PlatformAdmin = 'pragmatic-platform-admin'
    public static readonly PlatformEdge = 'pragmatic-platform-edge'
    public static readonly TenantAdmin = 'pragmatic-tenant-admin'
    public static readonly TenantIdp = 'pragmatic-tenant-idp'
    public static readonly UiUnpack = 'pragmatic-ui-unpack'
    public static readonly BuildStage = 'build'
    private static readonly FromPattern = /^FROM\s+\S+\s+AS\s+(\S+)$/i
    private static readonly Continuation = /\\\r?\n/g
    private static readonly LineBreak = /\r?\n/
    private static readonly Space = ' '
    private static readonly Utf8 = 'utf8'

    public static Text(...path: string[]): string
    {
        return readFileSync(join(ImageFiles.ServerRoot, ...path), ImageFiles.Utf8)
    }

    public static Dockerfile(): string
    {
        return ImageFiles.Text('docker', 'images', 'Dockerfile')
    }

    /** Each stage's instruction lines, keyed by stage name. */
    public static Stages(): Map<string, string[]>
    {
        const S = ImageFiles
        const stages = new Map<string, string[]>()
        let current: string[] | undefined
        for (const raw of S.Dockerfile().replace(S.Continuation, S.Space).split(S.LineBreak))
        {
            const line = raw.trim()
            const from = S.FromPattern.exec(line)
            if (from !== null)
            {
                current = []
                stages.set(from[1], current)
                continue
            }
            current?.push(line)
        }
        return stages
    }

    public static Stage(name: string): string[]
    {
        const stage = ImageFiles.Stages().get(name)
        assert.ok(stage !== undefined, `no Dockerfile stage ${name}`)
        return stage
    }

    public static Closure(): Record<string, IClosureEntry>
    {
        return JSON.parse(ImageFiles.Text('docker', 'images', 'closure.json')) as Record<string, IClosureEntry>
    }

    /** True when the app's closure copies the server-relative path (it is listed, or lies inside a listed dir). */
    public static Ships(app: string, serverPath: string): boolean
    {
        const path = ImageFiles.ServerDir + serverPath
        return ImageFiles.Closure()[app].files.some(f => path === f || path.startsWith(f + '/'))
    }
}

/**
 * The asset dirs the compiled control plane reads relative to its own modules, computed from the code's own constants and
 * mapped into the compiled tree (dist-tenant-admin mirrors the repo).
 */
class RuntimeAssets
{
    private static readonly AdminDir = 'admin'
    private static readonly ProbeName = 'probe'
    private static readonly ProbePort = 1

    public static Compiled(sourcePath: string): string
    {
        return ImageFiles.TenantAdminTree + relative(ImageFiles.ServerRoot, sourcePath).split(sep).join('/')
    }

    /** Every template's seed dir (the dev-blank template under admin/control-plane/templates, the demo seed under environments). */
    public static TemplateSeeds(): string[]
    {
        return Object.values(Template).map(t => RuntimeAssets.SeedOf(t))
    }

    public static SeedOf(template: Template): string
    {
        const R = RuntimeAssets
        return R.Compiled(TemplateCatalog.Resolve(template, R.ProbeName, R.ProbePort, TemplateCatalog.DefaultTypeFor(template)).seedDir)
    }

    public static Northwind(): string
    {
        return RuntimeAssets.Compiled(NorthwindApp.SourcePath)
    }

    public static OperatorPortal(): string
    {
        return [ImageFiles.TenantAdminTree + RuntimeAssets.AdminDir, ControlPlaneServer.PortalSegment, TenantPlaneComposer.DistSegment].join('/')
    }

    public static TenantPortal(): string
    {
        return [ImageFiles.TenantAdminTree + RuntimeAssets.AdminDir, TenantPlaneComposer.TenantPortalSegment, TenantPlaneComposer.DistSegment].join('/')
    }

    /** The default PRAGMATIC_RELEASE_TRUST_DIR: the trust dir two levels above the compiled control plane. */
    public static ReleaseKeys(): string
    {
        return ImageFiles.TenantAdminTree + ReleaseTrustKeys.DirName
    }
}

/** Runs a Dockerfile HEALTHCHECK's `node -e` probe against a local server answering /healthz. */
class HealthProbe
{
    public static readonly HealthPath = '/healthz'
    private static readonly ScriptPattern = /^HEALTHCHECK\s.*\sCMD node -e "(.*)"$/
    private static readonly PortVarPattern = /process\.env\.(\w+)/
    private static readonly Loopback = '127.0.0.1'
    private static readonly StatusOk = 200
    private static readonly StatusUnavailable = 503
    private static readonly StatusNotFound = 404
    private static readonly TempPrefix = 'healthcheck-'
    private static readonly Openssl = 'openssl'
    private static readonly KeyFile = 'key.pem'
    private static readonly CertFile = 'cert.pem'
    private static readonly Subject = '/CN=idp.test'

    /** The answer the server gives /healthz; anything else is 404. */
    public static Status = HealthProbe.StatusOk

    public static Script(stage: string): string | undefined
    {
        for (const line of ImageFiles.Stage(stage))
        {
            const match = HealthProbe.ScriptPattern.exec(line)
            if (match !== null)
            {
                return match[1]
            }
        }
        return undefined
    }

    public static Healthy(): void
    {
        HealthProbe.Status = HealthProbe.StatusOk
    }

    public static Unhealthy(): void
    {
        HealthProbe.Status = HealthProbe.StatusUnavailable
    }

    /** A self-signed certificate for a host that is not 127.0.0.1, as the tenant IdP's is. */
    public static SelfSigned(): { key: Buffer; cert: Buffer; dir: string }
    {
        const S = HealthProbe
        const dir = mkdtempSync(join(tmpdir(), S.TempPrefix))
        const key = join(dir, S.KeyFile)
        const cert = join(dir, S.CertFile)
        execFileSync(S.Openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', S.Subject],
            { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
        return { key: readFileSync(key), cert: readFileSync(cert), dir }
    }

    public static Handler(req: IncomingMessage, res: ServerResponse): void
    {
        res.statusCode = req.url === HealthProbe.HealthPath ? HealthProbe.Status : HealthProbe.StatusNotFound
        res.end()
    }

    public static Listen(server: Server): Promise<number>
    {
        return new Promise(done => server.listen(0, HealthProbe.Loopback, () => done((server.address() as AddressInfo).port)))
    }

    /** The probe's exit code with its port variable pointed at `port`. */
    public static Run(script: string, port: number): Promise<number>
    {
        const variable = HealthProbe.PortVarPattern.exec(script)
        assert.ok(variable !== null, 'the probe reads its port from the environment')
        return new Promise(done =>
        {
            execFile(process.execPath, ['-e', script], { env: { ...process.env, [variable[1]]: String(port) } }, error =>
                done(error === null ? 0 : typeof error.code === 'number' ? error.code : 1))
        })
    }
}

describe('image HEALTHCHECKs', () =>
{
    const servers: Server[] = []
    let tls: { key: Buffer; cert: Buffer; dir: string }
    let httpsPort = 0
    let httpPort = 0

    before(async () =>
    {
        tls = HealthProbe.SelfSigned()
        const https = createHttpsServer({ key: tls.key, cert: tls.cert }, HealthProbe.Handler)
        const http = createHttpServer(HealthProbe.Handler)
        servers.push(https, http)
        httpsPort = await HealthProbe.Listen(https)
        httpPort = await HealthProbe.Listen(http)
    })

    after(() =>
    {
        for (const server of servers)
        {
            server.close()
        }
        rmSync(tls.dir, { recursive: true, force: true })
    })

    it('the tenant IdP probe speaks HTTPS to its self-signed listener and still requires 200 on /healthz', async () =>
    {
        const script = HealthProbe.Script(ImageFiles.TenantIdp)
        assert.ok(script !== undefined)
        assert.match(script, /require\('node:https'\)/)
        assert.match(script, /rejectUnauthorized:false/)
        HealthProbe.Healthy()
        assert.equal(await HealthProbe.Run(script, httpsPort), 0)
        HealthProbe.Unhealthy()
        assert.equal(await HealthProbe.Run(script, httpsPort), 1)
        HealthProbe.Healthy()
    })

    it('every other probe passes on 200 from its plain-http /healthz and fails otherwise', async () =>
    {
        const probed = [...ImageFiles.Stages().keys()].filter(stage => stage !== ImageFiles.TenantIdp && HealthProbe.Script(stage) !== undefined)
        assert.ok(probed.length >= 3, probed.join(', '))
        for (const stage of probed)
        {
            const script = HealthProbe.Script(stage) as string
            assert.ok(script.includes(`path:'${HealthProbe.HealthPath}'`), stage)
            HealthProbe.Healthy()
            assert.equal(await HealthProbe.Run(script, httpPort), 0, stage)
            HealthProbe.Unhealthy()
            assert.equal(await HealthProbe.Run(script, httpPort), 1, stage)
        }
        HealthProbe.Healthy()
    })
})

describe('image contents', () =>
{
    it('platform-admin ships the operator portal, the release keys, the templates and the seeds it compiles, and no tenant portal', () =>
    {
        const app = ImageFiles.PlatformAdmin
        for (const path of [RuntimeAssets.OperatorPortal(), RuntimeAssets.ReleaseKeys(), RuntimeAssets.Northwind(), ...RuntimeAssets.TemplateSeeds()])
        {
            assert.ok(ImageFiles.Ships(app, path), path)
        }
        assert.ok(!ImageFiles.Ships(app, RuntimeAssets.TenantPortal()))
    })

    it('tenant-admin ships the tenant portal, the templates and the seeds, and never the Platform Admin SPA or the release keys', () =>
    {
        const app = ImageFiles.TenantAdmin
        for (const path of [RuntimeAssets.TenantPortal(), RuntimeAssets.Northwind(), ...RuntimeAssets.TemplateSeeds()])
        {
            assert.ok(ImageFiles.Ships(app, path), path)
        }
        assert.ok(!ImageFiles.Ships(app, RuntimeAssets.OperatorPortal()))
        assert.ok(!ImageFiles.Ships(app, RuntimeAssets.ReleaseKeys()))
    })

    it('platform-edge ships no SPA, seed or trust key', () =>
    {
        for (const path of [RuntimeAssets.OperatorPortal(), RuntimeAssets.TenantPortal(), RuntimeAssets.ReleaseKeys(), RuntimeAssets.Northwind(), RuntimeAssets.SeedOf(Template.DemoContoso)])
        {
            assert.ok(!ImageFiles.Ships(ImageFiles.PlatformEdge, path), path)
        }
    })

    it('ui-unpack ships only its own compile: nothing of the control-plane tree', () =>
    {
        const files = ImageFiles.Closure()[ImageFiles.UiUnpack].files
        assert.deepEqual(files.filter(f => f.includes(ImageFiles.TenantAdminTree)), [])
        assert.match(ImageFiles.Text('package.json'), /"build:ui-unpack": "tsc -p tsconfig\.ui-unpack\.json"/)
        const tsconfig = JSON.parse(ImageFiles.Text('tsconfig.ui-unpack.json')) as { files: string[]; include: string[] }
        assert.deepEqual(tsconfig.include, [])
        assert.equal(tsconfig.files.length, 1)
    })

    it('the build stage stages every asset set at the path the compiled code reads it from', () =>
    {
        const build = ImageFiles.Stage(ImageFiles.BuildStage).join('\n')
        const templates = dirname(RuntimeAssets.SeedOf(Template.DevBlank))
        const sampleApps = dirname(dirname(RuntimeAssets.Northwind()))
        for (const path of [RuntimeAssets.OperatorPortal(), RuntimeAssets.TenantPortal(), RuntimeAssets.ReleaseKeys(), templates, RuntimeAssets.SeedOf(Template.DemoContoso), sampleApps])
        {
            assert.ok(build.includes(path), path)
        }
    })

    it('the platform images start in their control-plane role', () =>
    {
        const env = (stage: string) => ImageFiles.Stage(stage).filter(line => line.startsWith('ENV '))
        assert.ok(env(ImageFiles.PlatformAdmin).includes(`ENV ${ControlPlaneRoles.EnvVar}=${ControlPlaneRole.Admin}`))
        assert.ok(env(ImageFiles.PlatformEdge).includes(`ENV ${ControlPlaneRoles.EnvVar}=${ControlPlaneRole.Edge}`))
    })

    it('names lmdb as the native addon the toolchain is for, not argon2 or bcrypt', () =>
    {
        const text = ImageFiles.Dockerfile()
        assert.match(text, /lmdb/)
        assert.doesNotMatch(text, /native argon2|argon2\/bcrypt in identity/)
    })

    it('bake labels carry nothing release-specific, so an unchanged image keeps its digest across releases', () =>
    {
        const bake = ImageFiles.Text('docker', 'docker-bake.hcl')
        assert.doesNotMatch(bake, /org\.opencontainers\.image\.(version|revision)/)
        assert.match(bake, /org\.opencontainers\.image\.source/)
    })
})
