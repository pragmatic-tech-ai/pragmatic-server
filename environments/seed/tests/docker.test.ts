import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DockerEnv, EnvKind, TenantPurposeName, type ILogProcess, type IProcessSpawn } from '../docker.js'

const Demo = { name: 'demo', kind: EnvKind.Demo, environmentId: 'contoso', purpose: TenantPurposeName.Runtime, hostPort: 8081 }

test('RunArgs maps bundle + env + port into a correct docker run invocation', () =>
{
    const args = DockerEnv.RunArgs(Demo, '/abs/bundle')
    assert.equal(args[0], 'run')
    assert.ok(args.includes('--name') && args.includes(DockerEnv.ContainerName(Demo)))
    assert.ok(args.includes('-p') && args.includes('8081:8080'))
    assert.ok(args.some(a => a.startsWith('PRAGMATIC_BASE_DIR=')))
    assert.ok(args.some(a => a === 'PRAGMATIC_TENANTS_FILE=/cfg/tenants.json'))
    assert.ok(args.includes(DockerEnv.ImageName))
    assert.ok(args.includes('-v') && args.some(a => a.includes(DockerEnv.VolumeName(Demo))))
})

test('container and volume names are environment-scoped and distinct across envs', () =>
{
    const dev = { name: 'dev', kind: EnvKind.Dev, environmentId: 'dev', purpose: TenantPurposeName.Development, hostPort: 8080 }
    assert.notEqual(DockerEnv.ContainerName(Demo), DockerEnv.ContainerName(dev))
    assert.notEqual(DockerEnv.VolumeName(Demo), DockerEnv.VolumeName(dev))
})

class FakeLogProcess implements ILogProcess
{
    public Data: ((chunk: string) => void) | undefined
    public Killed = false

    public OnData(cb: (chunk: string) => void): void
    {
        this.Data = cb
    }

    public OnClose(): void
    {
    }

    public Kill(): void
    {
        this.Killed = true
    }
}

class FakeSpawn implements IProcessSpawn
{
    public Command: string | undefined
    public Args: string[] | undefined
    public readonly Process = new FakeLogProcess()

    public Spawn(command: string, args: string[]): ILogProcess
    {
        this.Command = command
        this.Args = args
        return this.Process
    }
}

test('LogStream spawns docker logs -f --tail N <container>, forwards chunks, and Kill kills', () =>
{
    const spawn = new FakeSpawn()
    const got: string[] = []
    const proc = new DockerEnv(spawn).LogStream(Demo, c => got.push(c))
    assert.equal(spawn.Command, 'docker')
    assert.deepEqual(spawn.Args, ['logs', '-f', '--tail', '200', 'pragmatic-env-demo'])
    spawn.Process.Data?.('line1')
    assert.deepEqual(got, ['line1'])
    assert.equal(proc, spawn.Process)
    proc.Kill()
    assert.equal(spawn.Process.Killed, true)
})
