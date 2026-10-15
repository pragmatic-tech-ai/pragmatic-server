import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, AppWriteOpKind, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AppWriteOpDto, AppWriteResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import type { PragmaticAppsRegistry } from '../apps/pragmatic-apps-registry.js'

class EndpointFixture
{
    private static readonly PackagesPrefix = 'adw-pkgs-'
    private static readonly NoConnectors = 'no connectors'
    public static readonly AppName = 'x'

    public static Owner(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static NoGrants(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        return new AccessContext(principal, tenant, [], new ResourceAuthorizationPolicy())
    }

    public static Applied(): (name: string, ops: readonly AppWriteOpDto[]) => Promise<AppWriteResultDto>
    {
        return async (_name, ops) => ({ results: ops.map(() => ({ status: AppWriteStatus.Applied, id: 'srv-1' })) })
    }

    public static async With(purpose: TenantPurpose, context: AccessContext, write: (name: string, ops: readonly AppWriteOpDto[]) => Promise<AppWriteResultDto>, body: (client: PragmaticClient) => Promise<void>): Promise<void>
    {
        const packages = mkdtempSync(join(tmpdir(), EndpointFixture.PackagesPrefix))
        const server = new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const runtime = purpose === TenantPurpose.Runtime
        const applications = { List: async () => [], ApplicationFor: async (name: string) => ({ Manifest: { name, version: '1.0.0' } }) } as unknown as PragmaticAppsRegistry
        const appGraph = async (): Promise<IGraphQuery> => Promise.reject(new Error(EndpointFixture.NoConnectors))
        const appWrite = (_c: AccessContext, name: string, ops: readonly AppWriteOpDto[]): Promise<AppWriteResultDto> => write(name, ops)
        const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, context, () => Promise.reject(new Error(EndpointFixture.NoConnectors)), ctx => server.Graph(ctx), undefined, undefined, undefined, undefined, undefined, undefined, purpose, runtime ? applications : undefined, runtime ? appGraph : undefined, runtime ? appWrite : undefined)
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

const SampleOps: AppWriteOpDto[] = [{ op: AppWriteOpKind.Create, concept: 'shop.Widget', fields: { label: 'w' } }]

test('data/write on a development tenant is rejected', async () =>
{
    await EndpointFixture.With(TenantPurpose.Development, EndpointFixture.Owner(), EndpointFixture.Applied(), async client =>
    {
        await assert.rejects(() => client.WriteAppData({ operations: SampleOps }), /runtime/i)
    })
})

test('data/write before application/open is rejected', async () =>
{
    await EndpointFixture.With(TenantPurpose.Runtime, EndpointFixture.Owner(), EndpointFixture.Applied(), async client =>
    {
        await assert.rejects(() => client.WriteAppData({ operations: SampleOps }), /no application selected/i)
    })
})

test('a principal without Write is rejected by the policy gate', async () =>
{
    await EndpointFixture.With(TenantPurpose.Runtime, EndpointFixture.NoGrants(), EndpointFixture.Applied(), async client =>
    {
        await assert.rejects(() => client.WriteAppData({ operations: SampleOps }))
    })
})

test('runtime tenant routes an opened app write to the provider', async () =>
{
    await EndpointFixture.With(TenantPurpose.Runtime, EndpointFixture.Owner(), EndpointFixture.Applied(), async client =>
    {
        await client.OpenApplication(EndpointFixture.AppName)
        const out = await client.WriteAppData({ operations: SampleOps })
        assert.equal(out.results[0].status, AppWriteStatus.Applied)
        assert.equal(out.results[0].id, 'srv-1')
    })
})
