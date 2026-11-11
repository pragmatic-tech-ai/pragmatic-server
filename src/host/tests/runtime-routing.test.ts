import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'

class RuntimeRoutingFixture
{
    private static readonly PackagesPrefix = 'rr-pkgs-'
    private static readonly NoConnectors = 'no connectors'
    public static readonly AppName = 'x'

    private static Permissive(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    /** A Development tenant's connection (no application registry: application/* belongs to runtime tenants). */
    public static async With(body: (client: PragmaticClient) => Promise<void>): Promise<void>
    {
        const packages = mkdtempSync(join(tmpdir(), RuntimeRoutingFixture.PackagesPrefix))
        const server = new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, RuntimeRoutingFixture.Permissive(), () => Promise.reject(new Error(RuntimeRoutingFixture.NoConnectors)), server.DevCypher(), undefined, undefined, undefined, undefined, undefined, undefined, TenantPurpose.Development)
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
    await RuntimeRoutingFixture.With(async client =>
    {
        await assert.rejects(() => client.OpenApplication(RuntimeRoutingFixture.AppName), /runtime/i)
        await assert.rejects(() => client.ListApplications(), /runtime/i)
    })
})

