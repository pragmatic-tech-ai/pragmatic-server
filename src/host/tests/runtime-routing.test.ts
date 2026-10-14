import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import type { PragmaticAppsRegistry } from '../apps/pragmatic-apps-registry.js'

class RuntimeRoutingFixture
{
    private static readonly PackagesPrefix = 'rr-pkgs-'
    private static readonly NoConnectors = 'no connectors'
    public static readonly AnyQuery = 'MATCH (n) RETURN n'
    public static readonly AppName = 'x'

    private static Permissive(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static async With(purpose: TenantPurpose, body: (client: PragmaticClient) => Promise<void>): Promise<void>
    {
        const packages = mkdtempSync(join(tmpdir(), RuntimeRoutingFixture.PackagesPrefix))
        const server = new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const runtime = purpose === TenantPurpose.Runtime
        const applications = { List: async () => [], ApplicationFor: async (name: string) => ({ Manifest: { name, version: '1.0.0' } }) } as unknown as PragmaticAppsRegistry
        const appGraph = async (): Promise<IGraphQuery> => Promise.reject(new Error(RuntimeRoutingFixture.NoConnectors))
        const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, RuntimeRoutingFixture.Permissive(), () => Promise.reject(new Error(RuntimeRoutingFixture.NoConnectors)), ctx => server.Graph(ctx), undefined, undefined, undefined, undefined, undefined, undefined, purpose, runtime ? applications : undefined, runtime ? appGraph : undefined)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        try
        {
            await body(client)
        }
        finally
        {
            await client.DisposeAsync()
            handler.Dispose()
            await (languageService as SolutionLanguageService).WhenIdle()
            await server.Dispose()
            rmSync(packages, { recursive: true, force: true })
        }
    }
}

test('development tenant rejects application/open and application/list', async () =>
{
    await RuntimeRoutingFixture.With(TenantPurpose.Development, async client =>
    {
        await assert.rejects(() => client.OpenApplication(RuntimeRoutingFixture.AppName), /runtime/i)
        await assert.rejects(() => client.ListApplications(), /runtime/i)
    })
})

test('runtime tenant rejects cypher/query before an application is opened', async () =>
{
    await RuntimeRoutingFixture.With(TenantPurpose.Runtime, async client =>
    {
        await assert.rejects(() => client.CypherQuery(RuntimeRoutingFixture.AnyQuery), /no application selected/i)
    })
})

test('runtime tenant open binds the application', async () =>
{
    await RuntimeRoutingFixture.With(TenantPurpose.Runtime, async client =>
    {
        const summary = await client.OpenApplication(RuntimeRoutingFixture.AppName)
        assert.equal(summary.name, RuntimeRoutingFixture.AppName)
    })
})
