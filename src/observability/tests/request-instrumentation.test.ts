import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { PeriodicExportingMetricReader, InMemoryMetricExporter, AggregationTemporality } from '@opentelemetry/sdk-metrics'
import type { DataPoint } from '@opentelemetry/sdk-metrics'
import { InMemoryMessageSocket, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../../host/server-connection-handler.js'
import { Observability, ObservabilityRole } from '../observability.js'
import { RequestInstrumentation } from '../request-instrumentation.js'
import { NullLogger } from '../logger.js'
import type { ILogger } from '../logger.js'

class ThrowingLogger implements ILogger
{
    public Child(): ILogger
    {
        return this
    }

    public Info(): void
    {
        throw new Error('sink')
    }

    public Warn(): void
    {
        throw new Error('sink')
    }

    public Error(): void
    {
        throw new Error('sink')
    }
}

class Fixture
{
    public readonly SpanExporter = new InMemorySpanExporter()
    public readonly MetricReader = new PeriodicExportingMetricReader({ exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE), exportIntervalMillis: 2_147_483_647 })
    public readonly Observability: Observability

    public constructor()
    {
        this.Observability = Observability.ForTest({ role: ObservabilityRole.Host, serviceName: 'svc' }, this.SpanExporter, this.MetricReader)
    }

    public Instrumentation(): RequestInstrumentation
    {
        return RequestInstrumentation.FromObservability(this.Observability, new NullLogger())
    }

    public static Context(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('principal-xyz', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('principal-xyz', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static ViewerContext(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('viewer-1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('viewer-1', Role.Viewer, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static SolutionDir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), 'ps-ri-'))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), dir, { recursive: true })
        return dir
    }

    public static Cleanup(dir: string): void
    {
        rmSync(dir, { recursive: true, force: true })
    }

    public async Points(name: string): Promise<Array<DataPoint<number>>>
    {
        const collected = await this.MetricReader.collect()
        const points: Array<DataPoint<number>> = []
        for (const scope of collected.resourceMetrics.scopeMetrics)
        {
            for (const metric of scope.metrics)
            {
                if (metric.descriptor.name === name)
                {
                    points.push(...(metric.dataPoints as Array<DataPoint<number>>))
                }
            }
        }
        return points
    }
}

test('one successful request emits exactly one span and the success metrics with low-cardinality labels and no principal label', async () =>
{
    const fixture = new Fixture()
    const packages = mkdtempSync(join(tmpdir(), 'ps-pkgs-'))
    const solution = Fixture.SolutionDir()
    const server = new PragmaticServer({ packagesRoot: packages })
    await server.Start()
    const languageService = await server.LanguageService()
    const manager = await server.Manager()
    const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
    const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, Fixture.Context(), () => Promise.reject(new Error('no connectors')), fixture.Instrumentation())
    const client = PragmaticClient.CreateOverSocket(clientSocket)
    try
    {
        await client.OpenSolution(solution)
        await new Promise(resolve => setImmediate(resolve))
        const spans = fixture.SpanExporter.getFinishedSpans()
        assert.equal(spans.length, 1)
        assert.equal(spans[0]!.attributes.tenant, 't1')
        assert.equal(spans[0]!.attributes.principal, 'principal-xyz')
        assert.equal(spans[0]!.attributes.outcome, 'ok')
        const totals = await fixture.Points('requests_total')
        assert.equal(totals.length, 1)
        assert.equal(totals[0]!.value, 1)
        assert.equal(totals[0]!.attributes.tenant, 't1')
        assert.equal(totals[0]!.attributes.outcome, 'ok')
        assert.equal(totals[0]!.attributes.principal, undefined)
        const durations = await fixture.Points('request_duration_ms')
        assert.equal(durations.length, 1)
        assert.equal(durations[0]!.attributes.principal, undefined)
        const inFlight = await fixture.Points('requests_in_flight')
        assert.equal(inFlight[0]!.value, 0)
    }
    finally
    {
        await client.DisposeAsync()
        handler.Dispose()
        await (languageService as SolutionLanguageService).WhenIdle()
        await manager.CloseSolution()
        await server.Dispose()
        await fixture.Observability.Shutdown()
        Fixture.Cleanup(solution)
        Fixture.Cleanup(packages)
    }
})

test('a throwing operation increments request_errors_total, marks the span error, and in-flight returns to zero', async () =>
{
    const fixture = new Fixture()
    const instrumentation = fixture.Instrumentation()
    await assert.rejects(() => instrumentation.Run({ method: 'solution/open', tenant: 't1', principal: 'p1' }, () =>
    {
        throw new TypeError('bad')
    }))
    assert.equal(instrumentation.InFlight(), 0)
    const spans = fixture.SpanExporter.getFinishedSpans()
    assert.equal(spans.length, 1)
    assert.equal(spans[0]!.attributes.outcome, 'error')
    assert.equal(spans[0]!.attributes.error, 'TypeError')
    assert.equal(spans[0]!.status.code, 2)
    assert.equal(spans[0]!.events.length, 0)
    const errors = await fixture.Points('request_errors_total')
    assert.equal(errors.length, 1)
    assert.equal(errors[0]!.value, 1)
    assert.equal(errors[0]!.attributes.class, 'TypeError')
    assert.equal(errors[0]!.attributes.tenant, 't1')
    assert.equal(errors[0]!.attributes.principal, undefined)
    await fixture.Observability.Shutdown()
})

test('a request still returns its result even though exporters are inert in-memory', async () =>
{
    const fixture = new Fixture()
    const result = await fixture.Instrumentation().Run({ method: 'solution/active', tenant: 't1', principal: 'p1' }, () => 42)
    assert.equal(result, 42)
    await fixture.Observability.Shutdown()
})

test('concurrent requests keep the in-flight count accurate and net to zero', async () =>
{
    const fixture = new Fixture()
    const instrumentation = fixture.Instrumentation()
    let releaseA = (): void => {}
    let releaseB = (): void => {}
    const a = instrumentation.Run({ method: 'm', tenant: 't1', principal: 'p1' }, () => new Promise<void>(resolve => { releaseA = resolve }))
    const b = instrumentation.Run({ method: 'm', tenant: 't1', principal: 'p1' }, () => new Promise<void>(resolve => { releaseB = resolve }))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(instrumentation.InFlight(), 2)
    releaseA()
    releaseB()
    await Promise.all([a, b])
    assert.equal(instrumentation.InFlight(), 0)
    const inFlight = await fixture.Points('requests_in_flight')
    assert.equal(inFlight[0]!.value, 0)
    await fixture.Observability.Shutdown()
})

test('a denied request through the real handler rejects and records one error span and metric of class ResponseError', async () =>
{
    const fixture = new Fixture()
    const packages = mkdtempSync(join(tmpdir(), 'ps-pkgs-'))
    const solution = Fixture.SolutionDir()
    const server = new PragmaticServer({ packagesRoot: packages })
    await server.Start()
    const languageService = await server.LanguageService()
    const manager = await server.Manager()
    const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
    const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, Fixture.ViewerContext(), () => Promise.reject(new Error('no connectors')), fixture.Instrumentation())
    const client = PragmaticClient.CreateOverSocket(clientSocket)
    try
    {
        await assert.rejects(() => client.OpenSolution(solution))
        await new Promise(resolve => setImmediate(resolve))
        const spans = fixture.SpanExporter.getFinishedSpans()
        assert.equal(spans.length, 1)
        assert.equal(spans[0]!.attributes.outcome, 'error')
        assert.equal(spans[0]!.attributes.error, 'ResponseError')
        const errors = await fixture.Points('request_errors_total')
        assert.equal(errors.length, 1)
        assert.equal(errors[0]!.value, 1)
        assert.equal(errors[0]!.attributes.class, 'ResponseError')
        const totals = await fixture.Points('requests_total')
        assert.equal(totals.length, 1)
        assert.equal(totals[0]!.attributes.outcome, 'error')
    }
    finally
    {
        await client.DisposeAsync()
        handler.Dispose()
        await (languageService as SolutionLanguageService).WhenIdle()
        await server.Dispose()
        await fixture.Observability.Shutdown()
        Fixture.Cleanup(solution)
        Fixture.Cleanup(packages)
    }
})

test('with no instrumentation attached a request still succeeds and nothing is recorded', async () =>
{
    const fixture = new Fixture()
    const packages = mkdtempSync(join(tmpdir(), 'ps-pkgs-'))
    const solution = Fixture.SolutionDir()
    const server = new PragmaticServer({ packagesRoot: packages })
    await server.Start()
    const languageService = await server.LanguageService()
    const manager = await server.Manager()
    const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
    const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, Fixture.Context(), () => Promise.reject(new Error('no connectors')))
    const client = PragmaticClient.CreateOverSocket(clientSocket)
    try
    {
        await client.OpenSolution(solution)
        assert.notEqual(manager.ActiveSolution, undefined)
        assert.equal(fixture.SpanExporter.getFinishedSpans().length, 0)
    }
    finally
    {
        await client.DisposeAsync()
        handler.Dispose()
        await (languageService as SolutionLanguageService).WhenIdle()
        await manager.CloseSolution()
        await server.Dispose()
        await fixture.Observability.Shutdown()
        Fixture.Cleanup(solution)
        Fixture.Cleanup(packages)
    }
})

test('a throwing meter or logger sink never turns a successful request into an error', async () =>
{
    const fixture = new Fixture()
    const instrumentation = new RequestInstrumentation(fixture.Observability.Tracer(), fixture.Observability.Meter(), new ThrowingLogger())
    const result = await instrumentation.Run({ method: 'm', tenant: 't1', principal: 'p1' }, () => 7)
    assert.equal(result, 7)
    assert.equal(instrumentation.InFlight(), 0)
    assert.equal(fixture.SpanExporter.getFinishedSpans().length, 1)
    await fixture.Observability.Shutdown()
})
