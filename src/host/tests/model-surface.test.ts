import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'

class ModelFixture
{
    private static readonly SolutionPrefix = 'ps-sol-'
    private static readonly PackagesPrefix = 'ps-pkgs-'
    public static readonly WidgetId = 'acme.Widget'
    public static readonly UnknownMember = 'no/such/member'

    public static SolutionDir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), ModelFixture.SolutionPrefix))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), dir, { recursive: true })
        return dir
    }

    public static PackagesDir(): string
    {
        return mkdtempSync(join(tmpdir(), ModelFixture.PackagesPrefix))
    }

    public static Cleanup(dir: string): void
    {
        rmSync(dir, { recursive: true, force: true })
    }

    public static async WithClient(packages: string, body: (client: PragmaticClient, language: SolutionLanguageService) => Promise<void>): Promise<void>
    {
        const server = new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        try
        {
            await body(client, languageService as SolutionLanguageService)
        }
        finally
        {
            await client.DisposeAsync()
            handler.Dispose()
            await (languageService as SolutionLanguageService).WhenIdle()
            await manager.CloseSolution()
            await server.Dispose()
        }
    }
}

test('ModelView over the wire projects the member model to JSON including the fixture concept', async () =>
{
    const packages = ModelFixture.PackagesDir()
    const solution = ModelFixture.SolutionDir()
    try
    {
        await ModelFixture.WithClient(packages, async (client, language) =>
        {
            const summary = await client.OpenSolution(solution)
            const memberId = summary.members[0].id
            await language.WhenIdle()
            const projection = await client.ModelView(memberId)
            const ids = projection.members.map(m => m.id)
            assert.ok(ids.includes(ModelFixture.WidgetId))
            // the projection must be plain JSON - survives a round-trip unchanged
            assert.deepEqual(JSON.parse(JSON.stringify(projection)), projection)
        })
    }
    finally
    {
        ModelFixture.Cleanup(solution)
        ModelFixture.Cleanup(packages)
    }
})

test('ModelView for an unknown member id rejects', async () =>
{
    const packages = ModelFixture.PackagesDir()
    const solution = ModelFixture.SolutionDir()
    try
    {
        await ModelFixture.WithClient(packages, async client =>
        {
            await client.OpenSolution(solution)
            await assert.rejects(client.ModelView(ModelFixture.UnknownMember))
        })
    }
    finally
    {
        ModelFixture.Cleanup(solution)
        ModelFixture.Cleanup(packages)
    }
})

test('ModelView before any OpenSolution rejects', async () =>
{
    const packages = ModelFixture.PackagesDir()
    try
    {
        await ModelFixture.WithClient(packages, async client =>
        {
            await assert.rejects(client.ModelView('anything'))
        })
    }
    finally
    {
        ModelFixture.Cleanup(packages)
    }
})

test('Resources over the wire returns a JSON array for a node', async () =>
{
    const packages = ModelFixture.PackagesDir()
    const solution = ModelFixture.SolutionDir()
    try
    {
        await ModelFixture.WithClient(packages, async client =>
        {
            await client.OpenSolution(solution)
            const resources = await client.Resources(ModelFixture.WidgetId)
            assert.ok(Array.isArray(resources))
            assert.deepEqual(JSON.parse(JSON.stringify(resources)), resources)
            const unknown = await client.Resources('no.such.node')
            assert.deepEqual(unknown, [])
        })
    }
    finally
    {
        ModelFixture.Cleanup(solution)
        ModelFixture.Cleanup(packages)
    }
})
