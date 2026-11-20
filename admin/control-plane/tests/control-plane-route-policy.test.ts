import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AuthorizationOutcome, ClaimsAuthorizer, HttpMethod, RouteAuth, SessionPolicy, SessionRecord, type RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'
import { ControlPlaneHost, type ControlPlaneHostOptions } from '../control-plane-host.js'
import { OperatorRole } from '../operator-identity.js'
import { OperatorRoleClaims, OperatorSessions } from '../operator-sessions.js'

/**
 * The operator role policy of the console's route table (what OperatorAuthorization enforced before the console moved onto
 * pragmatic-app-host): operator.full may do everything; operator.read-only may read every route but the operator roster,
 * and may sign out and change its own password; anyone may sign in, probe the session and sign out.
 */
class RoutePolicyFixture
{
    public static readonly Reads: readonly string[] = [
        '/api/environments', '/api/fleet', '/api/activity', '/api/manifests', '/api/policies', '/api/gating', '/api/selections', '/api/rollouts',
        '/api/clients', '/api/clients/c1', '/api/tenants', '/api/tenants/t1', '/api/hives', '/api/hives/h1',
        '/api/tenants/t1/manifests', '/api/tenants/t1/email-domains', '/api/hives/h1/rollout', '/api/hives/h1/health', '/api/hives/h1/observations',
        '/api/hives/h1/ledger', '/api/hives/h1/bootstrap', '/api/hives/h1/agent-install', '/api/hives/h1/console-install',
        '/api/environments/e1/graphs', '/api/environments/e1/graphs/g1', '/api/environments/e1/loaded-graph',
    ]
    public static readonly FullOnly: ReadonlyArray<[HttpMethod, string]> = [
        [HttpMethod.Get, '/api/operators'], [HttpMethod.Post, '/api/operators'], [HttpMethod.Post, '/api/operators/role'],
        [HttpMethod.Post, '/api/operators/password-reset'], [HttpMethod.Post, '/api/operators/disabled'], [HttpMethod.Post, '/api/operators/revoke-sessions'],
        [HttpMethod.Post, '/api/provision'], [HttpMethod.Post, '/api/releases/refresh'], [HttpMethod.Post, '/api/manifests/1.0.0/withdrawn'],
        [HttpMethod.Delete, '/api/manifests/1.0.0/withdrawn'], [HttpMethod.Post, '/api/clients'], [HttpMethod.Delete, '/api/clients/c1'],
        [HttpMethod.Post, '/api/tenants'], [HttpMethod.Delete, '/api/tenants/t1'], [HttpMethod.Post, '/api/hives'], [HttpMethod.Delete, '/api/hives/h1'],
        [HttpMethod.Post, '/api/tenants/t1/gating'], [HttpMethod.Delete, '/api/tenants/t1/gating/1.0.0'], [HttpMethod.Post, '/api/tenants/t1/owner-password'],
        [HttpMethod.Put, '/api/tenants/t1/email-domains'], [HttpMethod.Post, '/api/tenants/t1/email-domains/approve'],
        [HttpMethod.Post, '/api/tenants/t1/email-domains/revoke'], [HttpMethod.Post, '/api/tenants/t1/email-domains/verify'],
        [HttpMethod.Put, '/api/tenants/t1/policy/channels'], [HttpMethod.Put, '/api/tenants/t1/policy/min-version'], [HttpMethod.Delete, '/api/tenants/t1/policy/min-version'],
        [HttpMethod.Post, '/api/tenants/t1/policy/hold'], [HttpMethod.Delete, '/api/tenants/t1/policy/hold'],
        [HttpMethod.Put, '/api/hives/h1/policy/channels'], [HttpMethod.Put, '/api/hives/h1/policy/min-version'], [HttpMethod.Delete, '/api/hives/h1/policy/min-version'],
        [HttpMethod.Post, '/api/hives/h1/policy/hold'], [HttpMethod.Delete, '/api/hives/h1/policy/hold'],
        [HttpMethod.Post, '/api/hives/h1/rollout-registration'], [HttpMethod.Post, '/api/hives/h1/agent-install'], [HttpMethod.Post, '/api/hives/h1/console-install'],
        [HttpMethod.Post, '/api/hives/h1/console/owner-password'], [HttpMethod.Put, '/api/hives/h1/console'], [HttpMethod.Delete, '/api/hives/h1/console'],
        [HttpMethod.Post, '/api/environments/e1/graphs'], [HttpMethod.Delete, '/api/environments/e1/graphs/g1'], [HttpMethod.Post, '/api/environments/e1/graphs/g1/promote'],
    ]
    public static readonly Public: ReadonlyArray<[HttpMethod, string]> = [
        [HttpMethod.Get, '/api/ping'], [HttpMethod.Post, '/api/login'], [HttpMethod.Get, '/api/session'], [HttpMethod.Post, '/api/logout'], [HttpMethod.Post, '/api/desktop/discover'],
    ]
    public static readonly SelfService = '/api/session/password'
    /** The socket ticket: any signed-in operator (the events socket itself admits both operator roles). */
    public static readonly Ticket = '/api/ws-ticket'

    public static Table(): RouteTable
    {
        const options = {
            Service: {}, Graphs: {}, Operator: {}, Directory: {}, Deployments: {}, Provisioning: {}, Observations: {},
            Sessions: new OperatorSessions(OperatorSessions.InMemory(), false),
            EmailDomains: {}, Discovery: {},
        } as unknown as ControlPlaneHostOptions
        return new ControlPlaneHost(options).Routes()
    }

    public static Session(role: OperatorRole): SessionRecord
    {
        const now = new Date()
        return new SessionRecord('id', 'p1', OperatorRoleClaims.Of({ email: 'op@example.com', principalId: 'p1', role }), now, new Date(now.getTime() + 60_000), now, new SessionPolicy(60_000))
    }

    public static Outcome(table: RouteTable, method: HttpMethod, path: string, role: OperatorRole): AuthorizationOutcome
    {
        const route = table.Match(method, path).Route
        assert.ok(route !== undefined, `${method} ${path} is declared`)
        return new ClaimsAuthorizer().Authorize(route.Definition, RoutePolicyFixture.Session(role))
    }
}

describe('ControlPlaneHost route policy', () =>
{
    const F = RoutePolicyFixture
    const table = F.Table()

    it('every read admits both operator roles', () =>
    {
        for (const path of F.Reads)
        {
            for (const role of [OperatorRole.Full, OperatorRole.ReadOnly])
            {
                assert.equal(F.Outcome(table, HttpMethod.Get, path, role), AuthorizationOutcome.Allowed, `GET ${path} as ${role}`)
            }
        }
    })

    it('the operator roster and every mutation admit operator.full only', () =>
    {
        for (const [method, path] of F.FullOnly)
        {
            assert.equal(F.Outcome(table, method, path, OperatorRole.Full), AuthorizationOutcome.Allowed, `${method} ${path} as Full`)
            assert.equal(F.Outcome(table, method, path, OperatorRole.ReadOnly), AuthorizationOutcome.Forbidden, `${method} ${path} as ReadOnly`)
        }
    })

    it('every operator may change its own password; sign-in, the session probe, sign-out and discovery are public', () =>
    {
        assert.equal(F.Outcome(table, HttpMethod.Post, F.SelfService, OperatorRole.ReadOnly), AuthorizationOutcome.Allowed)
        assert.equal(F.Outcome(table, HttpMethod.Post, F.SelfService, OperatorRole.Full), AuthorizationOutcome.Allowed)
        for (const [method, path] of F.Public)
        {
            assert.equal(table.Match(method, path).Route?.Definition.Auth, RouteAuth.Public, `${method} ${path}`)
        }
    })

    it('a session without an operator role is refused everywhere it is not public (deny by default)', () =>
    {
        const now = new Date()
        const bare = new SessionRecord('id', 'p1', OperatorRoleClaims.Of({ email: 'op@example.com', principalId: 'p1', role: OperatorRole.Full }).With(OperatorRoleClaims.RoleClaim, []), now, new Date(now.getTime() + 60_000), now, new SessionPolicy(60_000))
        const authorizer = new ClaimsAuthorizer()
        for (const [method, path] of [...F.FullOnly, ...F.Reads.map(p => [HttpMethod.Get, p] as [HttpMethod, string])])
        {
            const route = table.Match(method, path).Route
            assert.equal(authorizer.Authorize(route!.Definition, bare), AuthorizationOutcome.Forbidden, `${method} ${path}`)
        }
    })

    it('declares the events socket for both roles, as application roles', () =>
    {
        const socket = table.MatchSocket('/api/events')
        assert.equal(socket?.Route.Definition.Auth, RouteAuth.Session)
        assert.deepEqual(socket?.Route.Definition.AppRole, OperatorRoleClaims.Any)
        assert.equal(socket?.Route.Definition.Role, undefined)
    })

    it('names the operator roles as AppRole on every session route, never as a tenant Role', () =>
    {
        for (const [method, path] of [...F.FullOnly, ...F.Reads.map(p => [HttpMethod.Get, p] as [HttpMethod, string])])
        {
            const route = table.Match(method, path).Route!
            assert.equal(route.Definition.Role, undefined, `${method} ${path}`)
            assert.ok(route.Definition.AppRole !== undefined, `${method} ${path}`)
        }
    })

    it('the socket ticket is open to any signed-in operator', () =>
    {
        for (const role of [OperatorRole.Full, OperatorRole.ReadOnly])
        {
            assert.equal(F.Outcome(table, HttpMethod.Post, F.Ticket, role), AuthorizationOutcome.Allowed)
        }
    })
})
