import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:https'
import { createServer as httpsCreateServer } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate, createHash, randomBytes } from 'node:crypto'
import { Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import { MachineTls } from '../../cluster/machine-tls.js'
import type { MachineTlsRef } from '../../cluster/machine-tls.js'
import { AuthHttpEndpoint } from '../auth-http-endpoint.js'
import { MachineCertAuthenticator } from '../machine-cert-authenticator.js'
import { MachineCertIdentity, MachinePrincipalMap } from '../machine-principal-map.js'
import { PragmaticServerHost } from '../pragmatic-server-host.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'

class MachineFixture
{
    private static readonly Dir = 'src/tests/fixtures/tls/'
    public static readonly ServerRef: MachineTlsRef = { certFile: `${MachineFixture.Dir}server.pem`, keyFile: `${MachineFixture.Dir}server.key`, caFile: `${MachineFixture.Dir}ca.pem` }
    private static readonly ClientCert = `${MachineFixture.Dir}machine-client.pem`
    private static readonly ClientKey = `${MachineFixture.Dir}machine-client.key`
    private static readonly CaFile = `${MachineFixture.Dir}ca.pem`

    public static Fingerprint(): string
    {
        return createHash('sha256').update(new X509Certificate(readFileSync(MachineFixture.ClientCert)).raw).digest('hex')
    }

    public static ClientWithCert(): object
    {
        return { key: readFileSync(MachineFixture.ClientKey), cert: readFileSync(MachineFixture.ClientCert), ca: readFileSync(MachineFixture.CaFile) }
    }

    public static ClientWithoutCert(): object
    {
        return { ca: readFileSync(MachineFixture.CaFile), rejectUnauthorized: false }
    }

    public static Post(port: number, path: string, tls: object): Promise<{ status: number; body: string }>
    {
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: '127.0.0.1', port, path, method: 'POST', ...tls }, res =>
            {
                let body = ''
                res.on('data', chunk => { body += String(chunk) })
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
            })
            req.on('error', reject)
            req.end()
        })
    }
}

class DirectHttpsServer
{
    private constructor(public readonly Port: number, private readonly pack: ServerIdentityPack, private readonly server: ReturnType<typeof httpsCreateServer>)
    {
    }

    public static async Start(): Promise<DirectHttpsServer>
    {
        const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const authenticator = new MachineCertAuthenticator(new MachinePrincipalMap(new Map([[MachineFixture.Fingerprint(), { PrincipalId: 'svc-1', Groups: ['robots'] }]])))
        const server = httpsCreateServer(MachineTls.OptionalServer(MachineFixture.ServerRef), (req: IncomingMessage, res: ServerResponse) =>
        {
            const socket = req.socket as TLSSocket
            const identity = MachineCertIdentity.FromPeerCertificate(socket.authorized === true, socket.getPeerCertificate())
            void new AuthHttpEndpoint(pack, tenant, undefined, { authenticator, identity }).Handle(req, res)
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
        return new DirectHttpsServer((server.address() as AddressInfo).port, pack, server)
    }

    public Close(): Promise<void>
    {
        return new Promise<void>(resolve => this.server.close(() => resolve()))
    }
}

test('/auth/machine mints a session for a verified client cert and 401s without one', async () =>
{
    const served = await DirectHttpsServer.Start()
    try
    {
        const ok = await MachineFixture.Post(served.Port, '/auth/machine', MachineFixture.ClientWithCert())
        assert.equal(ok.status, 200)
        assert.ok((JSON.parse(ok.body) as { token: string }).token.length > 0)

        const anon = await MachineFixture.Post(served.Port, '/auth/machine', MachineFixture.ClientWithoutCert())
        assert.equal(anon.status, 401)
    }
    finally
    {
        await served.Close()
    }
})

test('a no-cert client still reaches other auth routes (optional mTLS keeps the connection)', async () =>
{
    const served = await DirectHttpsServer.Start()
    try
    {
        const res = await MachineFixture.Post(served.Port, '/auth/login', MachineFixture.ClientWithoutCert())
        assert.equal(res.status, 400)
    }
    finally
    {
        await served.Close()
    }
})

test('/auth/machine is 404 when no machine context is supplied', async () =>
{
    const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
    const endpoint = new AuthHttpEndpoint(pack, new Tenant('t1', TenantKind.SelfHosted, 'Tenant One'))
    const server = httpsCreateServer(MachineTls.OptionalServer(MachineFixture.ServerRef), (req, res) => void endpoint.Handle(req, res))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    try
    {
        const res = await MachineFixture.Post((server.address() as AddressInfo).port, '/auth/machine', MachineFixture.ClientWithCert())
        assert.equal(res.status, 404)
    }
    finally
    {
        await new Promise<void>(resolve => server.close(() => resolve()))
    }
})

test('a host with clientTls listens over TLS and serves a no-cert client', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'ph7b-tls-'))
    const keyPath = join(dir, 'key')
    writeFileSync(keyPath, randomBytes(32))
    const entries = new Map<string, TenantProvisioning>([['t1', { displayName: 'Tenant One' }]])
    const host = await PragmaticServerHost.StartAsync({ port: 0, baseDir: dir, masterKey: { keyFilePath: keyPath }, provisioning: new InMemoryTenantProvisioning(entries), clientTls: MachineFixture.ServerRef })
    try
    {
        const res = await new Promise<number>((resolve, reject) =>
        {
            const req = request({ host: '127.0.0.1', port: host.Address().port, path: '/healthz', method: 'GET', ...MachineFixture.ClientWithoutCert() }, r =>
            {
                r.resume()
                resolve(r.statusCode ?? 0)
            })
            req.on('error', reject)
            req.end()
        })
        assert.equal(res, 200)
    }
    finally
    {
        await host.DisposeAsync()
        rmSync(dir, { recursive: true, force: true })
    }
})
