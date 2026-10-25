import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EnvDefinition, EnvOidc } from '../../../environments/seed/bundle.js'
import type { ILogProcess } from '../../../environments/seed/docker.js'
import type { IDockerEnv, IBundleBuilder } from '../docker-env-port.js'
import { DockerEnvironmentRuntime, type EnvRuntimeContext } from '../environment-runtime.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'

class Fx
{
    public static readonly Port = 4321
    public static readonly EnvId = 'env-1'
    public static readonly Def = { name: 'e1', environmentId: Fx.EnvId } as unknown as EnvDefinition
    public static readonly Oidc = { clientId: 'c' } as unknown as EnvOidc
}

class RecDocker implements IDockerEnv
{
    public readonly Calls: { m: string; a: unknown[] }[] = []
    public readonly Process: ILogProcess = { OnData() {}, OnClose() {}, Kill() {} }
    private Rec(m: string, ...a: unknown[]): void { this.Calls.push({ m, a }) }
    public async EnsureImage(): Promise<boolean> { this.Rec('EnsureImage'); return true }
    public async Up(def: EnvDefinition, bundleDir: string, ca?: string): Promise<void> { this.Rec('Up', def, bundleDir, ca) }
    public async Down(def: EnvDefinition, removeData?: boolean): Promise<void> { this.Rec('Down', def, removeData) }
    public async Logs(def: EnvDefinition): Promise<string> { this.Rec('Logs', def); return 'L' }
    public LogStream(def: EnvDefinition, onData: (c: string) => void): ILogProcess { this.Rec('LogStream', def, onData); return this.Process }
    public async WaitHealthy(port: number, def: EnvDefinition): Promise<void> { this.Rec('WaitHealthy', port, def) }
    public async Running(name: string): Promise<boolean> { this.Rec('Running', name); return true }
    public async RemoveVolume(def: EnvDefinition): Promise<void> { this.Rec('RemoveVolume', def) }
    public BuildCommand(): string { return 'build-cmd' }
}

class RecBundle implements IBundleBuilder
{
    public readonly Calls: unknown[][] = []
    public async Generate(def: EnvDefinition, dir: string, seed?: string, oidc?: EnvOidc): Promise<void> { this.Calls.push([def, dir, seed, oidc]) }
}

class Harness
{
    public readonly Docker = new RecDocker()
    public readonly Bundle = new RecBundle()
    public readonly Runtime = new DockerEnvironmentRuntime(this.Docker, this.Bundle)
    public readonly Record: EnvironmentRecord = {
        name: 'e1', type: EnvType.Development, template: Template.DevBlank, environmentId: Fx.EnvId,
        hostPort: Fx.Port, containerName: 'ctr', volumeName: 'vol', bundleDir: '/b', createdAt: 'now', status: EnvStatus.Running
    }
    public readonly Ctx: EnvRuntimeContext = { def: Fx.Def, record: this.Record, bundleDir: '/b', seedDir: '/s', oidc: Fx.Oidc, caHostPath: '/ca' }
    public readonly Endpoint = { httpUrl: 'http://localhost:4321', wsUrl: 'ws://localhost:4321/?environment=env-1', hostPort: Fx.Port }
}

test('EnsureImage and BuildCommand forward to docker', async () =>
{
    const h = new Harness()
    assert.equal(await h.Runtime.EnsureImage(Fx.Def), true)
    assert.equal(h.Runtime.BuildCommand(), 'build-cmd')
    assert.deepEqual(h.Docker.Calls.map(c => c.m), ['EnsureImage'])
})

test('Prepare generates the bundle with seedDir and oidc', async () =>
{
    const h = new Harness()
    await h.Runtime.Prepare(h.Ctx)
    assert.deepEqual(h.Bundle.Calls, [[Fx.Def, '/b', '/s', Fx.Oidc]])
})

test('BringUp ups with the CA path and returns the localhost endpoint', async () =>
{
    const h = new Harness()
    assert.deepEqual(await h.Runtime.BringUp(h.Ctx), h.Endpoint)
    assert.deepEqual(h.Docker.Calls, [{ m: 'Up', a: [Fx.Def, '/b', '/ca'] }])
})

test('WaitHealthy forwards the record port', async () =>
{
    const h = new Harness()
    await h.Runtime.WaitHealthy(h.Ctx)
    assert.deepEqual(h.Docker.Calls, [{ m: 'WaitHealthy', a: [Fx.Port, Fx.Def] }])
})

test('Start ups without a CA path, waits healthy, returns the endpoint', async () =>
{
    const h = new Harness()
    assert.deepEqual(await h.Runtime.Start(h.Ctx), h.Endpoint)
    assert.deepEqual(h.Docker.Calls, [{ m: 'Up', a: [Fx.Def, '/b', undefined] }, { m: 'WaitHealthy', a: [Fx.Port, Fx.Def] }])
})

test('Stop, Teardown and RemoveVolume forward to docker', async () =>
{
    const h = new Harness()
    await h.Runtime.Stop(h.Ctx)
    await h.Runtime.Teardown(h.Ctx, true)
    await h.Runtime.RemoveVolume(h.Ctx)
    assert.deepEqual(h.Docker.Calls, [{ m: 'Down', a: [Fx.Def, undefined] }, { m: 'Down', a: [Fx.Def, true] }, { m: 'RemoveVolume', a: [Fx.Def] }])
})

test('Logs, LogStream and Probe forward to docker', async () =>
{
    const h = new Harness()
    const sink = (_c: string): void => {}
    assert.equal(await h.Runtime.Logs(h.Ctx), 'L')
    assert.equal(h.Runtime.LogStream(h.Ctx, sink), h.Docker.Process)
    assert.equal(await h.Runtime.Probe(h.Ctx), true)
    assert.deepEqual(h.Docker.Calls, [{ m: 'Logs', a: [Fx.Def] }, { m: 'LogStream', a: [Fx.Def, sink] }, { m: 'Running', a: ['ctr'] }])
})
