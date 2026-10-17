import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, DrainingError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { PeriodicExportingMetricReader, InMemoryMetricExporter, AggregationTemporality } from '@opentelemetry/sdk-metrics'
import { Observability, ObservabilityRole } from '../../observability/observability.js'
import { RequestInstrumentation } from '../../observability/request-instrumentation.js'
import { NullLogger } from '../../observability/logger.js'
import { DrainController } from '../../observability/drain-controller.js'
import { WsInFlightSource } from '../../observability/ws-in-flight-source.js'

class Fixtures
{
    public static OwnerContext(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    /** Wraps the real language service so DiagnosticsFor blocks on a gate the test controls. */
    public static Gated(inner: ILanguageService, gate: Promise<void>): ILanguageService
    {
        const gated = Object.create(inner) as ILanguageService
        gated.DiagnosticsFor = async (uri: string) =>
        {
            await gate
            return inner.DiagnosticsFor(uri)
        }
        return gated
    }
}

class Harness
{
    public readonly Handler: ServerConnectionHandler
    public readonly Client: PragmaticClient
    private readonly server: PragmaticServer
    private readonly service: SolutionLanguageService

    private constructor(server: PragmaticServer, service: SolutionLanguageService, handler: ServerConnectionHandler, client: PragmaticClient)
    {
        this.server = server
        this.service = service
        this.Handler = handler
        this.Client = client
    }

    public static async Create(gate: Promise<void>, instrumentation?: RequestInstrumentation): Promise<Harness>
    {
        const server = new PragmaticServer({ packagesRoot: mkdtempSync(join(tmpdir(), 'ps-pkgs-drain-')) })
        await server.Start()
        const service = (await server.LanguageService()) as SolutionLanguageService
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, Fixtures.Gated(service, gate), manager, Fixtures.OwnerContext(), () => Promise.reject(new Error('no connectors')), () => Promise.reject(new Error('no graph')), instrumentation)
        return new Harness(server, service, handler, PragmaticClient.CreateOverSocket(clientSocket))
    }

    public async Close(): Promise<void>
    {
        await this.Client.DisposeAsync()
        this.Handler.Dispose()
        await this.service.WhenIdle()
        await (await this.server.Manager()).CloseSolution()
        await this.server.Dispose()
    }
}

class Ticks
{
    public static async Settle(): Promise<void>
    {
        for (let i = 0; i < 5; i++)
        {
            await new Promise(resolve => setImmediate(resolve))
        }
    }
}

test('a never-ending request keeps InFlight at 1 and the bounded drain times out', async () =>
{
    const harness = await Harness.Create(new Promise<void>(() => { }))
    try
    {
        void harness.Client.DiagnosticsFor('file:///a.todl').catch(() => undefined)
        await Ticks.Settle()
        assert.equal(harness.Handler.InFlight(), 1)
        const outcome = await new DrainController(20).WaitForDrain(new WsInFlightSource([harness.Handler]))
        assert.equal(outcome.Drained, false)
        assert.ok(outcome.Remaining >= 1)
    }
    finally
    {
        await harness.Close()
    }
})

test('a running request completes after BeginDrain while a new request is rejected with the draining code', async () =>
{
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const harness = await Harness.Create(gate)
    try
    {
        const first = harness.Client.DiagnosticsFor('file:///a.todl')
        await Ticks.Settle()
        assert.equal(harness.Handler.InFlight(), 1)
        harness.Handler.BeginDrain()
        await assert.rejects(() => harness.Client.ActiveSolution(), (error: unknown) =>
        {
            assert.equal((error as { code?: number }).code, DrainingError.Code)
            return true
        })
        assert.equal(harness.Handler.InFlight(), 1)
        release()
        await first
        await Ticks.Settle()
        assert.equal(harness.Handler.InFlight(), 0)
    }
    finally
    {
        await harness.Close()
    }
})

test('the instrumented dispatch path returns InFlight to 0 on both success and failure', async () =>
{
    const observability = Observability.ForTest({ role: ObservabilityRole.Host, serviceName: 'svc' }, new InMemorySpanExporter(), new PeriodicExportingMetricReader({ exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE), exportIntervalMillis: 2_147_483_647 }))
    const instrumentation = RequestInstrumentation.FromObservability(observability, new NullLogger())
    const failing = Promise.reject(new Error('boom'))
    failing.catch(() => undefined)
    const ok = await Harness.Create(Promise.resolve(), instrumentation)
    try
    {
        await ok.Client.DiagnosticsFor('file:///a.todl')
        await Ticks.Settle()
        assert.equal(ok.Handler.InFlight(), 0)
    }
    finally
    {
        await ok.Close()
    }
    const bad = await Harness.Create(failing, instrumentation)
    try
    {
        await assert.rejects(() => bad.Client.DiagnosticsFor('file:///a.todl'))
        await Ticks.Settle()
        assert.equal(bad.Handler.InFlight(), 0)
    }
    finally
    {
        await bad.Close()
    }
})
