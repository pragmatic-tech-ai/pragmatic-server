import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, BuildState } from '@pragmatic-tech-ai/pragmatic-protocol'
import { GraphBuildState } from '@pragmatic-tech-ai/todl'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { BuildStateMapper } from '../build-state-mapper.js'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'

class ContextFixture
{
    public static Permissive(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static NoGrants(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('nobody', 't1', PrincipalKind.User, new Map(), [])
        return new AccessContext(principal, tenant, [], new ResourceAuthorizationPolicy())
    }
}

/**
 * Records engine build-state transitions and counts each completed Building -> Ready settle. WhenSettled(n) resolves
 * only once the n-th settle has been observed, so a caller that issued two switches can wait for the LATEST one and
 * cannot pass on a stale first-solution settle.
 */
class TransitionLog
{
    private readonly subscription: { dispose(): void }
    private settles = 0
    private sawBuilding = false
    private target = 1
    private waiter: (() => void) | undefined

    public constructor(language: SolutionLanguageService)
    {
        this.subscription = language.BuildStateChanged.subscribe(state =>
        {
            if (state === GraphBuildState.Building)
            {
                this.sawBuilding = true
            }
            else if (state === GraphBuildState.Ready && this.sawBuilding)
            {
                this.sawBuilding = false
                this.settles += 1
                if (this.settles >= this.target)
                {
                    this.waiter?.()
                }
            }
        })
    }

    public WhenSettled(count = 1): Promise<void>
    {
        this.target = count
        if (this.settles >= this.target)
        {
            return Promise.resolve()
        }
        return new Promise<void>(resolve =>
        {
            this.waiter = resolve
        })
    }

    public Dispose(): void
    {
        this.subscription.dispose()
    }
}

/** Collects client-side buildStateChanged pushes and awaits a given count (no sleeping). */
class PushLog
{
    private readonly seen: BuildState[] = []
    private waiting: { count: number, resolve: () => void } | undefined

    public constructor(client: PragmaticClient)
    {
        client.OnBuildStateChanged(p =>
        {
            this.seen.push(p.buildState)
            if (this.waiting !== undefined && this.seen.length >= this.waiting.count)
            {
                this.waiting.resolve()
            }
        })
    }

    public Seen(): readonly BuildState[]
    {
        return this.seen
    }

    public WhenCount(count: number): Promise<void>
    {
        if (this.seen.length >= count)
        {
            return Promise.resolve()
        }
        return new Promise<void>(resolve =>
        {
            this.waiting = { count, resolve }
        })
    }
}

class BuildStateFixture
{
    private static readonly SolutionPrefix = 'bs-sol-'
    private static readonly PackagesPrefix = 'bs-pkgs-'

    public static SolutionDir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), BuildStateFixture.SolutionPrefix))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), dir, { recursive: true })
        return dir
    }

    public static async Flush(language: SolutionLanguageService): Promise<void>
    {
        await language.WhenIdle()
        await new Promise<void>(resolve => setImmediate(resolve))
        await new Promise<void>(resolve => setImmediate(resolve))
    }

    public static async Run(context: AccessContext, body: (server: PragmaticServer, client: PragmaticClient, language: SolutionLanguageService, attach: () => PragmaticClient) => Promise<void>): Promise<void>
    {
        const packages = mkdtempSync(join(tmpdir(), BuildStateFixture.PackagesPrefix))
        const server = new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        const handlers: ServerConnectionHandler[] = []
        const clients: PragmaticClient[] = []
        const attach = (): PragmaticClient =>
        {
            const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
            handlers.push(ServerConnectionHandler.Attach(serverSocket, languageService, manager, context, () => Promise.reject(new Error('no connectors in this test')), () => Promise.reject(new Error('no graph'))))
            const client = PragmaticClient.CreateOverSocket(clientSocket)
            clients.push(client)
            return client
        }
        try
        {
            await body(server, attach(), languageService as SolutionLanguageService, attach)
        }
        finally
        {
            for (const client of clients)
            {
                await client.DisposeAsync()
            }
            for (const handler of handlers)
            {
                handler.Dispose()
            }
            await (languageService as SolutionLanguageService).WhenIdle()
            await manager.CloseSolution()
            await server.Dispose()
            rmSync(packages, { recursive: true, force: true })
        }
    }
}

test('BuildStateMapper maps all three', () =>
{
    assert.equal(BuildStateMapper.ToWire(GraphBuildState.Building), BuildState.Building)
    assert.equal(BuildStateMapper.ToWire(GraphBuildState.Ready), BuildState.Ready)
    assert.equal(BuildStateMapper.ToWire(GraphBuildState.Failed), BuildState.Failed)
})

test('solution/open then solution/active reports buildState ready once idle', async () =>
{
    const solution = BuildStateFixture.SolutionDir()
    try
    {
        await BuildStateFixture.Run(ContextFixture.Permissive(), async (_server, client, language) =>
        {
            const log = new TransitionLog(language)
            await client.OpenSolution(solution)
            await log.WhenSettled()
            log.Dispose()
            await language.WhenIdle()
            const active = await client.ActiveSolution()
            assert.equal(active?.buildState, BuildState.Ready)
        })
    }
    finally
    {
        rmSync(solution, { recursive: true, force: true })
    }
})

test('buildStateChanged is pushed on a switch', async () =>
{
    const first = BuildStateFixture.SolutionDir()
    const second = BuildStateFixture.SolutionDir()
    try
    {
        await BuildStateFixture.Run(ContextFixture.Permissive(), async (_server, client, language) =>
        {
            const pushes = new PushLog(client)
            await client.OpenSolution(first)
            await pushes.WhenCount(2)
            await client.OpenSolution(second)
            await pushes.WhenCount(4)
            await BuildStateFixture.Flush(language)
            assert.deepEqual(pushes.Seen(), [BuildState.Building, BuildState.Ready, BuildState.Building, BuildState.Ready])
        })
    }
    finally
    {
        rmSync(first, { recursive: true, force: true })
        rmSync(second, { recursive: true, force: true })
    }
})

test('no push when the gate cannot read', async () =>
{
    await BuildStateFixture.Run(ContextFixture.NoGrants(), async (_server, client, language) =>
    {
        const seen: BuildState[] = []
        client.OnBuildStateChanged(p => seen.push(p.buildState))
        await BuildStateFixture.Flush(language)
        language.BuildStateChanged.emit(GraphBuildState.Failed)
        await BuildStateFixture.Flush(language)
        assert.deepEqual(seen, [])
    })
})

test('the same emit path DOES push under a permissive gate (positive control)', async () =>
{
    await BuildStateFixture.Run(ContextFixture.Permissive(), async (_server, client, language) =>
    {
        const pushes = new PushLog(client)
        await BuildStateFixture.Flush(language)
        const before = pushes.Seen().length
        language.BuildStateChanged.emit(GraphBuildState.Failed)
        await pushes.WhenCount(before + 1)
        assert.equal(pushes.Seen()[pushes.Seen().length - 1], BuildState.Failed)
    })
})

test('a fresh client reads current buildState from solution/active after a switch', async () =>
{
    const first = BuildStateFixture.SolutionDir()
    const second = BuildStateFixture.SolutionDir()
    try
    {
        await BuildStateFixture.Run(ContextFixture.Permissive(), async (_server, client, language, attach) =>
        {
            const log = new TransitionLog(language)
            await client.OpenSolution(first)
            await client.OpenSolution(second)
            // wait for the SECOND solution's settle (two Building -> Ready cycles), not the stale first one
            await log.WhenSettled(2)
            log.Dispose()
            await BuildStateFixture.Flush(language)
            const fresh = attach()
            const active = await fresh.ActiveSolution()
            assert.equal(active?.buildState, BuildStateMapper.ToWire(language.BuildState))
            assert.equal(active?.buildState, BuildState.Ready)
        })
    }
    finally
    {
        rmSync(first, { recursive: true, force: true })
        rmSync(second, { recursive: true, force: true })
    }
})
