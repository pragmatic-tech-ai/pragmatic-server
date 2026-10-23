import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import type { Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecFileDockerExec, IdpContainerEnv } from '../idp-container-env.js'
import type { IDockerExec, IdpContainerSpec } from '../idp-container-env.js'
import { DevCa, IdpTlsMaterial } from '../../../src/idp/dev-ca.js'

class FakeExec implements IDockerExec
{
    public readonly Calls: string[][] = []
    public FailWith: Error | undefined

    public async Run(args: string[]): Promise<string>
    {
        this.Calls.push(args)
        if (this.FailWith !== undefined)
        {
            throw this.FailWith
        }
        return ''
    }
}

class Fixture
{
    public static readonly Spec: IdpContainerSpec = { tenantId: 't1', port: 9443, volumeName: 'idp-t1-data', adminTokenRef: 'admin.token', image: 'pragmatic-server:dev' }
}

class TlsFixture
{
    public Dir = mkdtempSync(join(tmpdir(), 'idpenv-'))
    public Server: Server | undefined
    public Ca: Buffer = Buffer.alloc(0)
    public Port = 0

    public async Start(status: number): Promise<void>
    {
        const files = DevCa.EnsureAt(this.Dir, 'host.docker.internal')
        this.Ca = readFileSync(files.caFile)
        const tls = IdpTlsMaterial.Load(files)
        const server = createServer({ key: tls.key, cert: tls.cert }, (req, res) =>
        {
            res.statusCode = req.url === '/healthz' ? status : 404
            res.end()
        })
        this.Server = server
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        this.Port = (server.address() as AddressInfo).port
    }

    public async Stop(): Promise<void>
    {
        const server = this.Server
        if (server !== undefined)
        {
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
        rmSync(this.Dir, { recursive: true, force: true })
    }
}

test('RunArgs builds the exact docker run argv', () =>
{
    assert.deepEqual(IdpContainerEnv.RunArgs(Fixture.Spec), [
        'run', '-d', '--name', 'pragmatic-idp-t1', '--entrypoint', 'node',
        '-p', '9443:9443', '--no-healthcheck',
        '--add-host', 'host.docker.internal:host-gateway',
        '-v', 'idp-t1-data:/idp-data',
        '-e', 'PRAGMATIC_IDP_PORT=9443',
        '-e', 'PRAGMATIC_IDP_BASE_URL=https://host.docker.internal:9443',
        '-e', 'PRAGMATIC_IDP_HOST=0.0.0.0',
        '-e', 'PRAGMATIC_IDP_DATA=/idp-data',
        '-e', 'PRAGMATIC_IDP_ADMIN_TOKEN_REF=admin.token',
        'pragmatic-server:dev', 'dist/bin/pragmatic-idpd.js'
    ])
})

test('Up runs the container; Down and RemoveVolume tolerate absence', async () =>
{
    const exec = new FakeExec()
    const env = new IdpContainerEnv(exec)
    await env.Up(Fixture.Spec)
    assert.deepEqual(exec.Calls[0], IdpContainerEnv.RunArgs(Fixture.Spec))
    await env.Down('pragmatic-idp-t1')
    await env.RemoveVolume('idp-t1-data')
    assert.deepEqual(exec.Calls[1], ['rm', '-f', 'pragmatic-idp-t1'])
    assert.deepEqual(exec.Calls[2], ['volume', 'rm', '-f', 'idp-t1-data'])
    exec.FailWith = new Error('no such container')
    await env.Down('x')
    await env.RemoveVolume('y')
})

test('WaitHealthy resolves on 200 over verified TLS', async () =>
{
    const fx = new TlsFixture()
    try
    {
        await fx.Start(200)
        await new IdpContainerEnv(new FakeExec()).WaitHealthy(fx.Port, fx.Ca, 3, 10)
    }
    finally
    {
        await fx.Stop()
    }
})

test('WaitHealthy rejects after the attempt budget on 503', async () =>
{
    const fx = new TlsFixture()
    try
    {
        await fx.Start(503)
        await assert.rejects(new IdpContainerEnv(new FakeExec()).WaitHealthy(fx.Port, fx.Ca, 2, 10), /did not become healthy/)
    }
    finally
    {
        await fx.Stop()
    }
})

test('Up propagates a docker failure with subcommand + stderr but not the argv', async () =>
{
    const failing = new IdpContainerEnv(new ExecFileDockerExec(process.execPath))
    await assert.rejects(failing.Up(Fixture.Spec), (e: Error) =>
    {
        assert.match(e.message, /run failed/)
        assert.ok(!e.message.includes(Fixture.Spec.adminTokenRef))
        assert.ok(!e.message.includes(Fixture.Spec.image))
        return true
    })
    const exec = new FakeExec()
    exec.FailWith = new Error('daemon down')
    await assert.rejects(new IdpContainerEnv(exec).Up(Fixture.Spec), /daemon down/)
})

test('SeedVolume runs a throwaway root container copying the host dir into the volume with open perms', async () =>
{
    const exec = new FakeExec()
    await new IdpContainerEnv(exec).SeedVolume('idp-t1-data', '/host/idp/t1', 'img:1')
    const args = exec.Calls[0]
    assert.equal(args[0], 'run')
    assert.ok(args.includes('--rm'))
    assert.deepEqual(args.slice(args.indexOf('--user'), args.indexOf('--user') + 2), ['--user', '0'])
    assert.ok(args.includes('idp-t1-data:/idp-data'))
    assert.ok(args.includes('/host/idp/t1:/seed:ro'))
    assert.ok(args.includes('img:1'))
    assert.match(args[args.length - 1], /cp -a \/seed\/\. \/idp-data\/ && chmod -R a\+rwX \/idp-data/)
})
