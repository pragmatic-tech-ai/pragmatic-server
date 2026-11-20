import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AuthorizationOutcome, ClaimsAuthorizer, HttpMethod, HttpMethods, RouteAuth, SessionPolicy, SessionRecord, type RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'
import { ConfigurationService } from '../configuration/configuration-service.js'
import { TenantConsoleHost } from '../tenant-console-host.js'
import { TenantPlaneComposer } from '../tenant-plane-composer.js'
import { TenantHostResolver } from '../tenant-auth/tenant-host-resolver.js'
import { TenantRoles } from '../tenant-auth/tenant-roles.js'
import { TenantSessionClaims, TenantSessions } from '../tenant-auth/tenant-sessions.js'
import { TenantAdminClientRegistry } from '../tenant-auth/tenant-admin-client-record.js'
import { MemoryRecordMap } from '../record-map.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import type { IEnvironmentService } from '../control-plane-host.js'
import { InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { MapSecretStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'

/**
 * The role policy of the tenant console's route table (what TenantAdminCapabilities enforced inside the endpoint before the
 * console moved onto pragmatic-app-host): the tenant role admin may do everything; the application role environment-admin
 * the environments and their rollout; a session with neither role may only read; sign-in, the session probe, sign-out and
 * the desktop surface are public (the desktop authenticates its own bearer).
 */
class TenantRoutePolicy
{
    public static readonly Environments: ReadonlyArray<[HttpMethod, string]> = [
        [HttpMethod.Post, '/tenant-api/environments'], [HttpMethod.Post, '/tenant-api/hives/h1/target'],
        [HttpMethod.Post, '/tenant-api/environments/e1/start'], [HttpMethod.Post, '/tenant-api/environments/e1/stop'], [HttpMethod.Post, '/tenant-api/environments/e1/restart'],
        [HttpMethod.Delete, '/tenant-api/environments/e1'], [HttpMethod.Post, '/tenant-api/environments/e1/maker-token'], [HttpMethod.Post, '/tenant-api/environments/e1/app-reader-grant'],
        [HttpMethod.Post, '/tenant-api/environments/e1/graphs'], [HttpMethod.Delete, '/tenant-api/environments/e1/graphs/g1'],
    ]
    public static readonly AdminOnly: ReadonlyArray<[HttpMethod, string]> = [
        [HttpMethod.Post, '/tenant-api/environments/e1/admin/accounts'], [HttpMethod.Delete, '/tenant-api/environments/e1/admin/accounts/p1'],
        [HttpMethod.Post, '/tenant-api/environments/e1/admin/grants'], [HttpMethod.Delete, '/tenant-api/environments/e1/admin/grants'],
        [HttpMethod.Post, '/tenant-api/environments/e1/admin/tokens'], [HttpMethod.Delete, '/tenant-api/environments/e1/admin/tokens'],
        [HttpMethod.Put, '/tenant-api/environments/e1/admin/security-model'], [HttpMethod.Put, '/tenant-api/environments/e1/admin/config'],
        [HttpMethod.Put, '/tenant-api/settings/email-domains'], [HttpMethod.Post, '/tenant-api/settings/email-domains/verify'],
        [HttpMethod.Post, '/tenant-api/configuration/components/pragmatic-env-server/versions'],
        [HttpMethod.Post, '/tenant-api/configuration/components/pragmatic-env-server/versions/1/apply'],
    ]
    public static readonly Reads: readonly string[] = [
        '/tenant-api/profile', '/tenant-api/hives', '/tenant-api/environments', '/tenant-api/manifests', '/tenant-api/hives/h1/rollout', '/tenant-api/hives/h1/health',
        '/tenant-api/hives/h1/ledger', '/tenant-api/environments/e1/admin/snapshot', '/tenant-api/environments/e1/admin/team-members/t1', '/tenant-api/environments/e1/graphs',
        '/tenant-api/settings/email-domains', '/tenant-api/configuration/components', '/tenant-api/configuration/components/pragmatic-env-server',
    ]
    public static readonly Public: ReadonlyArray<[HttpMethod, string]> = [
        [HttpMethod.Get, TenantConsoleHost.BeginPath], [HttpMethod.Get, TenantConsoleHost.CallbackPath], [HttpMethod.Get, TenantConsoleHost.SessionPath],
        [HttpMethod.Post, TenantConsoleHost.LogoutPath], [HttpMethod.Post, '/desktop/sign-in/begin'], [HttpMethod.Get, '/desktop/targets'],
    ]

    public static Table(): RouteTable
    {
        const stub = {} as never
        const directory = { GetTenant: () => undefined, ListHives: () => [] } as unknown as ITenantDirectory
        const view = { domains: [], editable: true, inHive: true, pending: [], verifications: [] }
        const service = { OnChanged: () => () => undefined } as unknown as IEnvironmentService
        const plane = TenantPlaneComposer.BuildTenantPlane({
            Idp: stub, Directory: directory, Service: service, Rollout: stub, Orchestrators: stub, Placement: stub,
            Sessions: new TenantSessions(TenantSessions.InMemory(), false), Resolver: new TenantHostResolver('admin.test', 'https', directory),
            FlowStates: new InMemoryOidcFlowStateStore(), ClientSecrets: { Store: new MapSecretStore(), Registry: new TenantAdminClientRegistry(new MemoryRecordMap()), TtlMs: 1 },
            Desktop: true, EmailDomains: { For: async () => view, Set: async () => view, Verify: async () => view }, Graphs: { Service: undefined } as never,
            Configuration: {} as ConfigurationService,
        })
        return new TenantConsoleHost({ Plane: plane, Resolver: new TenantHostResolver('admin.test', 'https', directory), Service: service }).Routes()
    }

    public static Session(roles: readonly string[], appRoles: readonly string[]): SessionRecord
    {
        const C = TenantSessionClaims
        const now = new Date()
        return new SessionRecord('id', 'p1', C.Of('acme', 'a@acme.test').With(C.RolesClaim, [...roles]).With(C.AppRolesClaim, [...appRoles]), now, new Date(now.getTime() + 60_000), now, new SessionPolicy(60_000))
    }

    public static Outcome(table: RouteTable, method: HttpMethod, path: string, session: SessionRecord): AuthorizationOutcome
    {
        const route = table.Match(method, path).Route
        assert.ok(route !== undefined, `${method} ${path} is declared`)
        return new ClaimsAuthorizer().Authorize(route.Definition, session)
    }
}

describe('TenantConsoleHost route policy', () =>
{
    const P = TenantRoutePolicy
    const table = P.Table()
    const admin = P.Session([TenantRoles.Admin], [])
    const environmentAdmin = P.Session([], [TenantRoles.EnvironmentAdmin])
    const none = P.Session([], [])

    it('the tenant role admin may do everything', () =>
    {
        for (const [method, path] of [...P.Environments, ...P.AdminOnly, ...P.Reads.map(p => [HttpMethod.Get, p] as [HttpMethod, string])])
        {
            assert.equal(P.Outcome(table, method, path, admin), AuthorizationOutcome.Allowed, `${method} ${path}`)
        }
    })

    it('environment-admin may change the environments and their rollout, not access, settings or configuration', () =>
    {
        for (const [method, path] of P.Environments)
        {
            assert.equal(P.Outcome(table, method, path, environmentAdmin), AuthorizationOutcome.Allowed, `${method} ${path}`)
        }
        for (const [method, path] of P.AdminOnly)
        {
            assert.equal(P.Outcome(table, method, path, environmentAdmin), AuthorizationOutcome.Forbidden, `${method} ${path}`)
        }
    })

    it('a session holding neither role may read, and change nothing (deny by default)', () =>
    {
        for (const path of P.Reads)
        {
            assert.equal(P.Outcome(table, HttpMethod.Get, path, none), AuthorizationOutcome.Allowed, `GET ${path}`)
        }
        for (const [method, path] of [...P.Environments, ...P.AdminOnly])
        {
            assert.equal(P.Outcome(table, method, path, none), AuthorizationOutcome.Forbidden, `${method} ${path}`)
        }
    })

    it('sign-in, the session probe, sign-out and the desktop surface are public; every tenant API route needs a session', () =>
    {
        for (const [method, path] of P.Public)
        {
            assert.equal(table.Match(method, path).Route?.Definition.Auth, RouteAuth.Public, `${method} ${path}`)
        }
        for (const [method, path] of [...P.Environments, ...P.AdminOnly, ...P.Reads.map(p => [HttpMethod.Get, p] as [HttpMethod, string])])
        {
            assert.equal(table.Match(method, path).Route?.Definition.Auth, RouteAuth.Session, `${method} ${path}`)
        }
    })

    it('every mutation of the tenant API names a role (none is open to any session but the socket ticket)', () =>
    {
        for (const [method, path] of [...P.Environments, ...P.AdminOnly])
        {
            const definition = table.Match(method, path).Route!.Definition
            assert.ok(HttpMethods.IsMutating(definition.Method))
            assert.ok(definition.Role !== undefined || definition.AppRole !== undefined, `${method} ${path}`)
        }
        assert.equal(P.Outcome(table, HttpMethod.Post, TenantConsoleHost.TicketPath, none), AuthorizationOutcome.Allowed)
    })

    it('declares the two tenant sockets as session sockets', () =>
    {
        assert.equal(table.MatchSocket(TenantConsoleHost.EventsPath)?.Route.Definition.Auth, RouteAuth.Session)
        assert.equal(table.MatchSocket('/tenant-api/environments/e1/logs/stream')?.Route.Definition.Auth, RouteAuth.Session)
    })
})
