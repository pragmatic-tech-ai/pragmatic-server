import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AuthorizationOutcome, ClaimsAuthorizer, RequestContext, RouteTable, SessionPolicy, SessionRecord } from '@pragmatic-tech-ai/pragmatic-app-host'
import { AppliedConfigurationCodec, InMemoryConfigurationRepository, type AppliedConfiguration, type ApplyTarget } from '@pragmatic-tech-ai/pragmatic-configuration'
import { PgSession } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { ConfigurationDiff, ConfigurationChangeKind } from '../configuration/configuration-diff.js'
import { ConfigurationNoTargetError, ConfigurationService } from '../configuration/configuration-service.js'
import { ConfigurationTargets } from '../configuration/configuration-targets.js'
import { ConsoleComponents } from '../configuration/console-components.js'
import { ConfigurationApplyUnavailableError, KubeConfigurationApplier, UnavailableConfigurationApplier, type IConfigurationApplier } from '../configuration/kube-configuration-applier.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { KubeContentType, KubeMethod, KubeApiClient, type IKubeTransport, type KubeResponse } from '../kube-api-client.js'
import { TenantAdminDatabase } from '../tenant-admin-database.js'
import { TenantConfigurationEndpoint } from '../tenant-api/tenant-configuration-endpoint.js'
import { TenantRoles } from '../tenant-auth/tenant-roles.js'
import { TenantSessionClaims } from '../tenant-auth/tenant-sessions.js'
import { ResRecorder } from './res-recorder.js'

/** Records every apply; `Fail` makes the next one throw. */
class RecordingApplier implements IConfigurationApplier
{
    public readonly Applied: { applied: AppliedConfiguration; target: ApplyTarget }[] = []
    public Fail = false

    public get Available(): boolean
    {
        return true
    }

    public async Apply(applied: AppliedConfiguration, target: ApplyTarget): Promise<void>
    {
        if (this.Fail)
        {
            throw new Error('the cluster said no: secret detail')
        }
        this.Applied.push({ applied, target })
    }
}

/** A Kubernetes API transport that records every call and answers 200. */
class RecordingTransport implements IKubeTransport
{
    public readonly Calls: { method: KubeMethod; path: string; body: unknown; type: KubeContentType }[] = []

    public async Send(method: KubeMethod, path: string, body: string | undefined, type: KubeContentType): Promise<KubeResponse>
    {
        this.Calls.push({ method, path, body: body === undefined ? undefined : JSON.parse(body), type })
        return { status: 200, body: '{}' }
    }
}

class ConfigFixture
{
    public static readonly Tenant = 'acme'
    public static readonly Server = 'pragmatic-env-server'
    public static readonly Admin = 'subject-admin'

    public static Env(name: string, tenantId: string = ConfigFixture.Tenant, bound: boolean = true): EnvironmentRecord
    {
        return {
            name, type: EnvType.Development, template: Template.DevBlank, environmentId: name, tenantId, hiveId: bound ? 'h1' : undefined, hostPort: 8101, containerName: 'c', volumeName: 'v',
            bundleDir: '/b', createdAt: '2026-01-01T00:00:00.000Z', status: EnvStatus.Running,
        }
    }

    public static Service(applier: IConfigurationApplier = new RecordingApplier()): ConfigurationService
    {
        const environments = { List: () => [ConfigFixture.Env('dev1'), ConfigFixture.Env('dev2'), ConfigFixture.Env('beta-dev', 'beta'), ConfigFixture.Env('loose', ConfigFixture.Tenant, false)] }
        return new ConfigurationService(new InMemoryConfigurationRepository(), ConsoleComponents.Release(), new ConfigurationTargets(environments), applier)
    }

    /** A valid env-server document: the descriptor's defaults are enough, so an empty options object validates. */
    public static readonly Document = { options: {} }

    public static Session(roles: readonly string[]): SessionRecord
    {
        const C = TenantSessionClaims
        const claims = C.Of(ConfigFixture.Tenant, 'ann@acme.test').With(C.RolesClaim, [...roles])
        const now = new Date()
        return new SessionRecord('sid', ConfigFixture.Admin, claims, now, new Date(now.getTime() + 60_000), now, new SessionPolicy(60_000))
    }

    /** Runs one request through the configuration routes the way the host does (route, roles, handler). */
    public static async Send(endpoint: TenantConfigurationEndpoint, method: string, path: string, body?: unknown, roles: readonly string[] = [TenantRoles.Admin]): Promise<{ status: number; json: Record<string, unknown> }>
    {
        const table = new RouteTable()
        endpoint.Register(table)
        const url = new URL(path, 'http://localhost')
        const match = table.Match(method, url.pathname)
        assert.ok(match.Route !== undefined, method + ' ' + path)
        const session = ConfigFixture.Session(roles)
        const res = new ResRecorder()
        if (new ClaimsAuthorizer().Authorize(match.Route.Definition, session) !== AuthorizationOutcome.Allowed)
        {
            return { status: 403, json: {} }
        }
        const text = body === undefined ? '' : JSON.stringify(body)
        const req = Object.assign(Readable.from(text === '' ? [] : [Buffer.from(text)]), { method, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) } })
        await match.Route.Definition.Handler(new RequestContext(req as unknown as IncomingMessage, res as unknown as ServerResponse, url.pathname, match.Params, url.searchParams, session, '127.0.0.1', 65536))
        return { status: res.status, json: res.body === '' ? {} : JSON.parse(res.body) as Record<string, unknown> }
    }
}

describe('ConfigurationDiff', () =>
{
    it('names every added, removed and changed member by its JSON pointer, in path order', () =>
    {
        const changes = ConfigurationDiff.Between(
            { options: { core: { port: 1, bind: 'a' }, gone: { x: 1 }, 'a/b': { '~': 1 } } },
            { options: { core: { port: 2, bind: 'a', extra: true }, 'a/b': { '~': 2 } } })
        assert.deepEqual(changes, [
            { path: '/options/a~1b/~0', kind: ConfigurationChangeKind.Changed, before: 1, after: 2 },
            { path: '/options/core/extra', kind: ConfigurationChangeKind.Added, after: true },
            { path: '/options/core/port', kind: ConfigurationChangeKind.Changed, before: 1, after: 2 },
            { path: '/options/gone', kind: ConfigurationChangeKind.Removed, before: { x: 1 } },
        ])
        assert.deepEqual(ConfigurationDiff.Between({ a: [1, 2] }, { a: [1, 2] }), [])
    })
})

describe('ConsoleComponents', () =>
{
    it('carries the hive components of this release, by name', () =>
    {
        const catalogue = ConsoleComponents.Release()
        assert.deepEqual(catalogue.Names(), ['pragmatic-env-gateway', 'pragmatic-env-server', 'pragmatic-hive-agent', 'pragmatic-tenant-admin', 'pragmatic-tenant-idp'])
        assert.equal(catalogue.Of('pragmatic-platform-admin'), undefined)
    })
})

describe('ConfigurationService', () =>
{
    it('lists every component with its head and the environment-server targets of the tenant\'s hive-bound environments', async () =>
    {
        const list = await ConfigFixture.Service().List(ConfigFixture.Tenant)
        const server = list.find(c => c.component === ConfigFixture.Server)!
        assert.equal(server.head, null)
        assert.deepEqual(server.targets.map(t => [t.environment, t.namespace, t.deployment, t.applied]), [
            ['dev1', 'pragmatic-env-dev1', 'pragmatic-env-dev1-server', null], ['dev2', 'pragmatic-env-dev2', 'pragmatic-env-dev2-server', null],
        ])
        assert.deepEqual(list.find(c => c.component === 'pragmatic-tenant-idp')?.targets, [])
    })

    it('saves validated versions in order, refuses a literal secret and a stale base', async () =>
    {
        const service = ConfigFixture.Service()
        const first = await service.Save(ConfigFixture.Tenant, ConfigFixture.Server, 0, ConfigFixture.Document, ConfigFixture.Admin, 'first')
        assert.equal(first.version, 1)
        assert.equal(first.author, ConfigFixture.Admin)
        await assert.rejects(service.Save(ConfigFixture.Tenant, ConfigFixture.Server, 0, ConfigFixture.Document, ConfigFixture.Admin, ''), /version 1, not 0/)
        await assert.rejects(service.Save(ConfigFixture.Tenant, ConfigFixture.Server, 1, { options: { nope: {} } }, ConfigFixture.Admin, ''), /rejected/)
        assert.equal((await service.Component(ConfigFixture.Tenant, ConfigFixture.Server)).versions.length, 1)
    })

    it('applies a version to an environment: the ConfigMap and the rolled deployment, recorded applied; the list shows it', async () =>
    {
        const applier = new RecordingApplier()
        const service = ConfigFixture.Service(applier)
        await service.Save(ConfigFixture.Tenant, ConfigFixture.Server, 0, ConfigFixture.Document, ConfigFixture.Admin, '')
        const record = await service.Apply(ConfigFixture.Tenant, ConfigFixture.Server, 1, 'dev1', ConfigFixture.Admin)
        assert.equal(record.outcome, 'applied')
        assert.equal(record.environment, 'dev1')
        assert.equal(applier.Applied[0]?.target.Deployment, 'pragmatic-env-dev1-server')
        assert.equal(applier.Applied[0]?.applied.Version, 1)
        const listed = (await service.List(ConfigFixture.Tenant)).find(c => c.component === ConfigFixture.Server)!
        assert.equal(listed.head, 1)
        assert.deepEqual(listed.targets.map(t => t.applied), [1, null])
    })

    it('a failed write is recorded failed with a fixed detail (the cluster\'s text is not kept)', async () =>
    {
        const applier = new RecordingApplier()
        applier.Fail = true
        const service = ConfigFixture.Service(applier)
        await service.Save(ConfigFixture.Tenant, ConfigFixture.Server, 0, ConfigFixture.Document, ConfigFixture.Admin, '')
        const record = await service.Apply(ConfigFixture.Tenant, ConfigFixture.Server, 1, 'dev1', ConfigFixture.Admin)
        assert.deepEqual([record.outcome, record.detail], ['failed', ConfigurationService.WriteFailedDetail])
    })

    it('refuses an unknown component, version or environment, a component without a target, and a console outside its cluster', async () =>
    {
        const service = ConfigFixture.Service()
        await service.Save(ConfigFixture.Tenant, ConfigFixture.Server, 0, ConfigFixture.Document, ConfigFixture.Admin, '')
        await assert.rejects(service.Component(ConfigFixture.Tenant, 'pragmatic-platform-admin'), /does not configure/)
        await assert.rejects(service.Apply(ConfigFixture.Tenant, ConfigFixture.Server, 9, 'dev1', ConfigFixture.Admin), /does not exist/)
        await assert.rejects(service.Apply(ConfigFixture.Tenant, ConfigFixture.Server, 1, 'beta-dev', ConfigFixture.Admin), /environment does not exist/)
        await assert.rejects(service.Apply(ConfigFixture.Tenant, ConfigFixture.Server, 1, 'loose', ConfigFixture.Admin), ConfigurationNoTargetError, 'an environment outside the hive has no deployment to write')
        await service.Save(ConfigFixture.Tenant, 'pragmatic-tenant-idp', 0, { options: {} }, ConfigFixture.Admin, '')
        await assert.rejects(service.Apply(ConfigFixture.Tenant, 'pragmatic-tenant-idp', 1, 'dev1', ConfigFixture.Admin), ConfigurationNoTargetError)
        await assert.rejects(service.Apply(ConfigFixture.Tenant, 'pragmatic-tenant-idp', 1, 'missing', ConfigFixture.Admin), /environment does not exist/, 'unknown before no target')
        const offline = ConfigFixture.Service(new UnavailableConfigurationApplier())
        await offline.Save(ConfigFixture.Tenant, ConfigFixture.Server, 0, ConfigFixture.Document, ConfigFixture.Admin, '')
        await assert.rejects(offline.Apply(ConfigFixture.Tenant, ConfigFixture.Server, 1, 'dev1', ConfigFixture.Admin), ConfigurationApplyUnavailableError)
        assert.deepEqual((await offline.Component(ConfigFixture.Tenant, ConfigFixture.Server)).applies, [], 'nothing is recorded')
    })

    it('diffs two versions (from 0 is the empty document) and keeps tenants apart', async () =>
    {
        const service = ConfigFixture.Service()
        await service.Save(ConfigFixture.Tenant, ConfigFixture.Server, 0, ConfigFixture.Document, ConfigFixture.Admin, '')
        const diff = await service.Diff(ConfigFixture.Tenant, ConfigFixture.Server, 0, 1)
        assert.deepEqual(diff.changes, [{ path: '/options', kind: ConfigurationChangeKind.Added, after: {} }])
        assert.deepEqual((await service.Component('beta', ConfigFixture.Server)).versions, [])
    })

    it('runs over the console database (pg-mem)', async () =>
    {
        const database = TenantAdminDatabase.Over(new PgSession(SqlTestSessions.MemPool()))
        const service = new ConfigurationService(await database.Configuration(), ConsoleComponents.Release(), new ConfigurationTargets({ List: () => [ConfigFixture.Env('dev1')] }), new RecordingApplier())
        await service.Save(ConfigFixture.Tenant, ConfigFixture.Server, 0, ConfigFixture.Document, ConfigFixture.Admin, 'sql')
        assert.equal((await service.Apply(ConfigFixture.Tenant, ConfigFixture.Server, 1, 'dev1', ConfigFixture.Admin)).outcome, 'applied')
        assert.equal((await service.Version(ConfigFixture.Tenant, ConfigFixture.Server, 1)).comment, 'sql')
    })
})

describe('KubeConfigurationApplier', () =>
{
    it('applies the pragmatic-config ConfigMap in the namespace and puts the content hash on the deployment\'s pod template', async () =>
    {
        const transport = new RecordingTransport()
        const applier = new KubeConfigurationApplier(new KubeApiClient(transport))
        const capture = new RecordingApplier()
        const viaCapture = ConfigFixture.Service(capture)
        await viaCapture.Save(ConfigFixture.Tenant, ConfigFixture.Server, 0, ConfigFixture.Document, ConfigFixture.Admin, '')
        await viaCapture.Apply(ConfigFixture.Tenant, ConfigFixture.Server, 1, 'dev1', ConfigFixture.Admin)
        const { applied, target } = capture.Applied[0]!
        await applier.Apply(applied, target)
        assert.equal(transport.Calls.length, 2)
        const [configMap, roll] = transport.Calls
        assert.equal(configMap?.method, KubeMethod.Patch)
        assert.equal(configMap?.type, KubeContentType.ApplyPatch)
        assert.ok(configMap?.path.startsWith('/api/v1/namespaces/pragmatic-env-dev1/configmaps/pragmatic-config-pragmatic-env-server?fieldManager='))
        assert.deepEqual(configMap?.body, AppliedConfigurationCodec.ToConfigMap(applied, 'pragmatic-env-dev1'))
        assert.equal(roll?.type, KubeContentType.StrategicMerge)
        assert.equal(roll?.path, '/apis/apps/v1/namespaces/pragmatic-env-dev1/deployments/pragmatic-env-dev1-server')
        assert.deepEqual(roll?.body, { spec: { template: { metadata: { annotations: AppliedConfigurationCodec.PodTemplateAnnotations(applied) } } } })
    })
})

describe('TenantConfigurationEndpoint', () =>
{
    const Base = '/tenant-api/configuration/components/'

    it('reads are open to any session of the tenant; saving and applying need the tenant role admin', async () =>
    {
        const endpoint = new TenantConfigurationEndpoint(ConfigFixture.Service())
        assert.equal((await ConfigFixture.Send(endpoint, 'GET', '/tenant-api/configuration/components', undefined, [])).status, 200)
        assert.equal((await ConfigFixture.Send(endpoint, 'POST', Base + ConfigFixture.Server + '/versions', { basedOn: 0, document: ConfigFixture.Document }, [])).status, 403)
        assert.equal((await ConfigFixture.Send(endpoint, 'POST', Base + ConfigFixture.Server + '/versions/1/apply', { environment: 'dev1' }, [])).status, 403)
    })

    it('a save answers 201; an invalid document 422 with paths and fixed messages (never the value); a stale base 409 with the head', async () =>
    {
        const endpoint = new TenantConfigurationEndpoint(ConfigFixture.Service())
        const saved = await ConfigFixture.Send(endpoint, 'POST', Base + ConfigFixture.Server + '/versions', { basedOn: 0, document: ConfigFixture.Document, comment: 'c' })
        assert.equal(saved.status, 201)
        assert.equal(saved.json.version, 1)
        const stale = await ConfigFixture.Send(endpoint, 'POST', Base + ConfigFixture.Server + '/versions', { basedOn: 0, document: ConfigFixture.Document })
        assert.deepEqual([stale.status, stale.json.head], [409, 1])
        const invalid = await ConfigFixture.Send(endpoint, 'POST', Base + ConfigFixture.Server + '/versions', { basedOn: 1, document: { options: { core: { port: 'hunter2-not-a-port' } } } })
        assert.equal(invalid.status, 422)
        assert.ok(Array.isArray(invalid.json.errors) && (invalid.json.errors as { path: string }[]).length > 0)
        assert.equal(JSON.stringify(invalid.json).includes('hunter2'), false)
        assert.equal((await ConfigFixture.Send(endpoint, 'POST', Base + ConfigFixture.Server + '/versions', { basedOn: 'x', document: [] })).status, 400)
    })

    it('views a version, diffs, applies; an unknown component or version is 404, a console outside its cluster 503', async () =>
    {
        const endpoint = new TenantConfigurationEndpoint(ConfigFixture.Service())
        await ConfigFixture.Send(endpoint, 'POST', Base + ConfigFixture.Server + '/versions', { basedOn: 0, document: ConfigFixture.Document })
        const version = await ConfigFixture.Send(endpoint, 'GET', Base + ConfigFixture.Server + '/versions/1')
        assert.deepEqual([version.status, version.json.document], [200, ConfigFixture.Document])
        assert.equal((await ConfigFixture.Send(endpoint, 'GET', Base + ConfigFixture.Server + '/diff?from=0&to=1')).status, 200)
        assert.equal((await ConfigFixture.Send(endpoint, 'GET', Base + ConfigFixture.Server + '/diff?from=a&to=1')).status, 400)
        assert.equal((await ConfigFixture.Send(endpoint, 'POST', Base + ConfigFixture.Server + '/versions/1/apply', { environment: 'dev1' })).json.outcome, 'applied')
        assert.equal((await ConfigFixture.Send(endpoint, 'GET', Base + 'pragmatic-platform-admin')).status, 404)
        assert.equal((await ConfigFixture.Send(endpoint, 'GET', Base + ConfigFixture.Server + '/versions/7')).status, 404)
        const offline = new TenantConfigurationEndpoint(ConfigFixture.Service(new UnavailableConfigurationApplier()))
        await ConfigFixture.Send(offline, 'POST', Base + ConfigFixture.Server + '/versions', { basedOn: 0, document: ConfigFixture.Document })
        assert.equal((await ConfigFixture.Send(offline, 'POST', Base + ConfigFixture.Server + '/versions/1/apply', { environment: 'dev1' })).status, 503)
    })
})
