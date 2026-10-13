import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PresentedSecret, Grant, Role, ResourceRef, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Tenant } from '@pragmatic-tech-ai/todl-identity'
import type { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import { AuthHttpEndpoint } from '../auth-http-endpoint.js'
import { PragmaticServerHost } from '../pragmatic-server-host.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'
import { AuditSurface, AuditOutcome } from '../access-audit.js'
import type { IAccessAuditSink, AccessAuditEvent } from '../access-audit.js'

class CapturingSink implements IAccessAuditSink
{
    public readonly Events: AccessAuditEvent[] = []

    public Record(event: AccessAuditEvent): Promise<void>
    {
        this.Events.push(event)
        return Promise.resolve()
    }
}

class ThrowingSink implements IAccessAuditSink
{
    public Record(): Promise<void>
    {
        throw new Error('sink down')
    }
}

class AuthAuditFixture
{
    public static async Run(audit: IAccessAuditSink, body: (base: string) => Promise<void>, direct?: (pack: ServerIdentityPack, tenant: Tenant) => Promise<void>): Promise<void>
    {
        const baseDir = mkdtempSync(join(tmpdir(), 'ps-base-'))
        mkdirSync(join(baseDir, 't1'), { recursive: true })
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), join(baseDir, 't1', 'solution'), { recursive: true })
        const keyEnv = 'PS_AUTH_AUDIT_KEY'
        process.env[keyEnv] = randomBytes(32).toString('base64')
        const entries = new Map<string, TenantProvisioning>([['t1', { displayName: 'Tenant One' }]])
        const host = await PragmaticServerHost.StartAsync({ host: '127.0.0.1', port: 0, baseDir, masterKey: { base64Env: keyEnv }, provisioning: new InMemoryTenantProvisioning(entries), audit })
        const pack = await host.IdentityPackForTest('t1')
        await pack.Registrar.Register(await host.TenantForTest('t1'), 'a@x.io', 'p1', new PresentedSecret('pw-123456'))
        await pack.Grants.Save(new Grant('p1', Role.Admin, new ResourceRef(ResourceKind.Tenant, 't1', [])))
        try
        {
            await direct?.(pack, await host.TenantForTest('t1'))
            await body(`http://${host.Address().host}:${host.Address().port}`)
        }
        finally
        {
            await host.DisposeAsync()
            rmSync(baseDir, { recursive: true, force: true })
            delete process.env[keyEnv]
        }
    }

    public static Login(base: string, password: string): Promise<Response>
    {
        return fetch(`${base}/auth/login?tenant=t1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@x.io', password }) })
    }
}

test('a successful login audits an http Allow and a bad password audits an http AuthFailure', async () =>
{
    const sink = new CapturingSink()
    await AuthAuditFixture.Run(sink, async base =>
    {
        assert.equal((await AuthAuditFixture.Login(base, 'pw-123456')).status, 200)
        assert.equal((await AuthAuditFixture.Login(base, 'wrong')).status, 401)
        await new Promise(resolve => setImmediate(resolve))
        const http = sink.Events.filter(e => e.Surface === AuditSurface.Http && e.MethodOrPath.includes('/auth/login'))
        assert.ok(http.some(e => e.Outcome === AuditOutcome.Allow && e.PrincipalId === 'p1'))
        assert.ok(http.some(e => e.Outcome === AuditOutcome.AuthFailure))
        for (const event of sink.Events)
        {
            assert.equal(JSON.stringify(event).includes('pw-123456'), false)
            assert.equal(JSON.stringify(event).includes('wrong'), false)
        }
    })
})

test('a throwing audit sink never changes the auth response', async () =>
{
    await AuthAuditFixture.Run(new ThrowingSink(), async base =>
    {
        assert.equal((await AuthAuditFixture.Login(base, 'pw-123456')).status, 200)
        assert.equal((await AuthAuditFixture.Login(base, 'wrong')).status, 401)
    })
})

test('an OIDC callback with no OIDC authenticator configured audits an AuthFailure', async () =>
{
    const sink = new CapturingSink()
    await AuthAuditFixture.Run(sink, async () => undefined, async (pack, tenant) =>
    {
        const oidc = { BeginAuthorization: () => Promise.reject(new Error('unused')), AuthenticatorFor: () => undefined }
        const endpoint = new AuthHttpEndpoint(pack, tenant, oidc, undefined, undefined, sink)
        const server = createServer((req, res) => void endpoint.Handle(req, res))
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        try
        {
            const port = (server.address() as AddressInfo).port
            const res = await fetch(`http://127.0.0.1:${port}/auth/oidc/callback?code=c&state=s`)
            assert.equal(res.status, 404)
            await new Promise(resolve => setImmediate(resolve))
            assert.ok(sink.Events.some(e => e.Surface === AuditSurface.Http && e.MethodOrPath === '/auth/oidc/callback' && e.Outcome === AuditOutcome.AuthFailure))
        }
        finally
        {
            await new Promise(resolve => server.close(resolve))
        }
    })
})
