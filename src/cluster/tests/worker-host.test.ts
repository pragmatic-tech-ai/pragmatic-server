import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { Grant, Role, ResourceRef, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticClient, WsMessageSocket } from '@pragmatic-tech-ai/pragmatic-protocol'
import { MachineTls } from '../machine-tls.js'
import type { MachineTlsRef } from '../machine-tls.js'
import { WorkerHost } from '../worker-host.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'
import { NodePlatform } from '../../platform/node-platform.js'

class RecordingPlatform extends NodePlatform
{
    public identityRoots: string[] = []

    public override CreateIdentityStores(identityRoot: string, masterKey: Buffer)
    {
        this.identityRoots.push(identityRoot)
        return super.CreateIdentityStores(identityRoot, masterKey)
    }
}

class WorkerFixture
{
    public static readonly KeyEnv = 'PS_WORKER_KEY'

    public static TlsRef(): MachineTlsRef
    {
        const dir = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'tls')
        return { certFile: join(dir, 'server.pem'), keyFile: join(dir, 'server.key'), caFile: join(dir, 'ca.pem') }
    }

    public static ClientTls(): MachineTlsRef
    {
        const dir = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'tls')
        return { certFile: join(dir, 'client.pem'), keyFile: join(dir, 'client.key'), caFile: join(dir, 'ca.pem') }
    }

    public static Start(...tenantIds: string[]): { baseDir: string }
    {
        const baseDir = mkdtempSync(join(tmpdir(), 'ps-wh-'))
        const fixture = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution')
        for (const id of tenantIds)
        {
            mkdirSync(join(baseDir, id), { recursive: true })
            cpSync(fixture, join(baseDir, id, 'solution'), { recursive: true })
        }
        process.env[WorkerFixture.KeyEnv] = randomBytes(32).toString('base64')
        return { baseDir }
    }

    public static Provisioning(...tenantIds: string[]): InMemoryTenantProvisioning
    {
        const entries = new Map<string, TenantProvisioning>()
        for (const id of tenantIds)
        {
            entries.set(id, { displayName: id })
        }
        return new InMemoryTenantProvisioning(entries)
    }

    public static Options(baseDir: string, provisioning: InMemoryTenantProvisioning)
    {
        return { host: '127.0.0.1', port: 0, baseDir, masterKey: { base64Env: WorkerFixture.KeyEnv }, provisioning, tls: WorkerFixture.TlsRef() }
    }

    public static async TokenFor(worker: WorkerHost, tenantId: string): Promise<string>
    {
        const server = await worker.RegistryForTest().ServerFor(tenantId)
        const pack = await server.Pack()
        await pack.Grants.Save(new Grant(tenantId, Role.Admin, new ResourceRef(ResourceKind.Tenant, tenantId, [])))
        return (await pack.Tokens.Issue(server.Tenant(), tenantId, [], null)).Token
    }

    public static Dial(address: { host: string; port: number }, tenantId: string, bearer: string | null, withClientCert: boolean): WebSocket
    {
        const client = withClientCert ? MachineTls.Client(WorkerFixture.ClientTls()) : undefined
        const headers: Record<string, string> = { 'x-pragmatic-tenant': tenantId }
        if (bearer !== null)
        {
            headers['authorization'] = `Bearer ${bearer}`
        }
        return new WebSocket(`wss://${address.host}:${address.port}/`, { key: client?.key, cert: client?.cert, ca: client?.ca, rejectUnauthorized: true, servername: '127.0.0.1', headers })
    }

    public static readonly SettleMs = 300

    public static async Settle(): Promise<void>
    {
        await new Promise<void>(resolve => setTimeout(resolve, WorkerFixture.SettleMs))
    }

    public static Cleanup(baseDir: string): void
    {
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[WorkerFixture.KeyEnv]
    }
}

test('a gateway (valid client cert + tenant + bearer) attaches and opens the tenant solution', async () =>
{
    const { baseDir } = WorkerFixture.Start('t1')
    const worker = await WorkerHost.StartAsync(WorkerFixture.Options(baseDir, WorkerFixture.Provisioning('t1')))
    try
    {
        const token = await WorkerFixture.TokenFor(worker, 't1')
        const ws = WorkerFixture.Dial(worker.Address(), 't1', token, true)
        await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject) })
        const client = PragmaticClient.CreateOverSocket(new WsMessageSocket(ws))
        const summary = await client.OpenSolution(join(baseDir, 't1', 'solution'))
        assert.equal(summary.members.length, 1)
        await client.DisposeAsync()
    }
    finally
    {
        await WorkerFixture.Settle()
        await worker.DisposeAsync()
        WorkerFixture.Cleanup(baseDir)
    }
})

test('a connection without a trusted client cert fails the TLS handshake', async () =>
{
    const { baseDir } = WorkerFixture.Start('t1')
    const worker = await WorkerHost.StartAsync(WorkerFixture.Options(baseDir, WorkerFixture.Provisioning('t1')))
    try
    {
        const token = await WorkerFixture.TokenFor(worker, 't1')
        await assert.rejects(() => new Promise<void>((resolve, reject) =>
        {
            const ws = WorkerFixture.Dial(worker.Address(), 't1', token, false)
            ws.on('open', () => { ws.close(); resolve() })
            ws.on('error', reject)
        }))
    }
    finally
    {
        await worker.DisposeAsync()
        WorkerFixture.Cleanup(baseDir)
    }
})

test('a bad bearer is rejected by the worker (ws closes without a usable connection)', async () =>
{
    const { baseDir } = WorkerFixture.Start('t1')
    const worker = await WorkerHost.StartAsync(WorkerFixture.Options(baseDir, WorkerFixture.Provisioning('t1')))
    try
    {
        const ws = WorkerFixture.Dial(worker.Address(), 't1', 'not-a-real-token', true)
        await new Promise<void>(resolve => { ws.on('close', () => resolve()); ws.on('error', () => resolve()) })
        assert.ok(ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING)
    }
    finally
    {
        await worker.DisposeAsync()
        WorkerFixture.Cleanup(baseDir)
    }
})

test('a platform passed in the options is forwarded into the per-tenant server', async () =>
{
    const { baseDir } = WorkerFixture.Start('t1')
    const platform = new RecordingPlatform()
    const worker = await WorkerHost.StartAsync({ ...WorkerFixture.Options(baseDir, WorkerFixture.Provisioning('t1')), platform })
    try
    {
        await WorkerFixture.TokenFor(worker, 't1')
        assert.equal(platform.identityRoots.length, 1)
    }
    finally
    {
        await worker.DisposeAsync()
        WorkerFixture.Cleanup(baseDir)
    }
})
