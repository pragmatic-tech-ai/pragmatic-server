import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { KubectlCli, PortForwardError, type IExecFile, type IProcessSpawner, type ISpawnedProcess } from '../kubectl.js'
import { ClusterTunnelPool, TunnelPoolClosedError } from '../cluster-tunnel-pool.js'

class FakeProcess implements ISpawnedProcess
{
    public readonly Stdout = new PassThrough()
    public Killed = false
    private readonly exits: (() => void)[] = []

    public Kill(): void
    {
        if (this.Killed)
        {
            return
        }
        this.Killed = true
        this.Exit()
    }

    public OnExit(cb: () => void): void
    {
        this.exits.push(cb)
    }

    public Exit(): void
    {
        for (const cb of [...this.exits])
        {
            cb()
        }
    }

    public Print(line: string): void
    {
        this.Stdout.write(line)
    }
}

class FakeSpawner implements IProcessSpawner
{
    public readonly Spawned: { file: string; args: readonly string[]; process: FakeProcess }[] = []
    /** When set, each spawned process prints this text right away. */
    public Line: ((remotePort: number) => string) | undefined = port => `Forwarding from 127.0.0.1:51234 -> ${port}\n`

    public Spawn(file: string, args: readonly string[]): ISpawnedProcess
    {
        const process = new FakeProcess()
        this.Spawned.push({ file, args, process })
        const line = this.Line
        if (line !== undefined)
        {
            const remote = Number(String(args[args.indexOf(Fx.PortForwardVerb) + 2]).split(':')[1])
            setImmediate(() => process.Print(line(remote)))
        }
        return process
    }
}

class NoExec implements IExecFile
{
    public Run(): Promise<{ stdout: string; stderr: string }>
    {
        throw new Error('exec must not be used by PortForward')
    }
}

class Fx
{
    public static readonly Context = 'ctx-1'
    public static readonly Namespace = 'ns'
    public static readonly Target = 'svc/x'
    public static readonly OtherTarget = 'svc/y'
    public static readonly Key = 'k'
    public static readonly OtherKey = 'k2'
    public static readonly RemotePort = 8080
    public static readonly LocalPort = 51234
    public static readonly IdleMs = 300_000
    public static readonly PortForwardVerb = 'port-forward'
    public static readonly Leaked = 'hunter2'

    public static Cli(): KubectlCli
    {
        return new KubectlCli(Fx.Context, new NoExec())
    }

    public static Open(spawner: IProcessSpawner, target: string = Fx.Target): () => ReturnType<KubectlCli['PortForward']>
    {
        return () => Fx.Cli().PortForward(Fx.Namespace, target, Fx.RemotePort, spawner)
    }
}

test('PortForward runs kubectl port-forward on the context and resolves the printed local port', async () =>
{
    const spawner = new FakeSpawner()
    const fwd = await Fx.Open(spawner)()
    assert.equal(fwd.LocalPort, Fx.LocalPort)
    assert.equal(spawner.Spawned.length, 1)
    assert.equal(spawner.Spawned[0].file, 'kubectl')
    assert.deepEqual(spawner.Spawned[0].args, ['--context', Fx.Context, '-n', Fx.Namespace, Fx.PortForwardVerb, Fx.Target, '0:' + String(Fx.RemotePort), '--address', '127.0.0.1'])
    assert.equal(fwd.Process, spawner.Spawned[0].process)
})

test('PortForward ignores a forwarding line for another remote port and a split line still parses', async () =>
{
    const spawner = new FakeSpawner()
    spawner.Line = undefined
    const pending = Fx.Open(spawner)()
    const proc = spawner.Spawned[0].process
    proc.Print('Forwarding from 127.0.0.1:40000 -> 9999\nForwarding from 127.0')
    proc.Print('.0.1:40001 -> 8080\n')
    const fwd = await pending
    assert.equal(fwd.LocalPort, 40001)
})

test('PortForward rejects and kills the process when the forwarding line never appears within 15 s', async (t) =>
{
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const spawner = new FakeSpawner()
    spawner.Line = undefined
    const pending = Fx.Open(spawner)()
    spawner.Spawned[0].process.Print('some noise\n')
    t.mock.timers.tick(14_999)
    let settled = false
    pending.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    t.mock.timers.tick(1)
    await assert.rejects(pending, PortForwardError)
    assert.equal(spawner.Spawned[0].process.Killed, true)
})

test('PortForward rejects on an early exit without surfacing process output', async () =>
{
    const spawner = new FakeSpawner()
    spawner.Line = undefined
    const pending = Fx.Open(spawner)()
    spawner.Spawned[0].process.Print('error: password=' + Fx.Leaked + ' rejected\n')
    spawner.Spawned[0].process.Exit()
    await assert.rejects(pending, (err: Error) => err instanceof PortForwardError && !err.message.includes(Fx.Leaked))
})

test('Acquire opens one tunnel and leases its local port', async () =>
{
    const spawner = new FakeSpawner()
    const pool = new ClusterTunnelPool()
    const lease = await pool.Acquire(Fx.Key, Fx.Open(spawner))
    assert.equal(lease.LocalPort, Fx.LocalPort)
    assert.equal(spawner.Spawned.length, 1)
    pool.CloseAll()
})

test('two concurrent Acquire calls for one key spawn once', async () =>
{
    const spawner = new FakeSpawner()
    const pool = new ClusterTunnelPool()
    const open = Fx.Open(spawner)
    const [a, b] = await Promise.all([pool.Acquire(Fx.Key, open), pool.Acquire(Fx.Key, open)])
    assert.equal(a.LocalPort, Fx.LocalPort)
    assert.equal(b.LocalPort, Fx.LocalPort)
    assert.equal(spawner.Spawned.length, 1)
    assert.equal((await pool.Acquire(Fx.Key, open)).LocalPort, Fx.LocalPort)
    assert.equal(spawner.Spawned.length, 1)
    pool.CloseAll()
})

test('distinct keys get distinct tunnels', async () =>
{
    const spawner = new FakeSpawner()
    const pool = new ClusterTunnelPool()
    await pool.Acquire(Fx.Key, Fx.Open(spawner))
    await pool.Acquire(Fx.OtherKey, Fx.Open(spawner, Fx.OtherTarget))
    assert.equal(spawner.Spawned.length, 2)
    pool.CloseAll()
    assert.ok(spawner.Spawned.every(s => s.process.Killed))
})

test('a held lease keeps its tunnel open past the 5 minute idle window', async (t) =>
{
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const spawner = new FakeSpawner()
    const pool = new ClusterTunnelPool()
    await pool.Acquire(Fx.Key, Fx.Open(spawner))
    t.mock.timers.tick(Fx.IdleMs * 3)
    assert.equal(spawner.Spawned[0].process.Killed, false)
    pool.CloseAll()
})

test('releasing the last lease starts the 5 minute idle countdown, then the tunnel is killed', async (t) =>
{
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const spawner = new FakeSpawner()
    const pool = new ClusterTunnelPool()
    const open = Fx.Open(spawner)
    const lease = await pool.Acquire(Fx.Key, open)
    t.mock.timers.tick(Fx.IdleMs * 2)
    lease.Release()
    const proc = spawner.Spawned[0].process
    t.mock.timers.tick(Fx.IdleMs - 1)
    assert.equal(proc.Killed, false)
    t.mock.timers.tick(1)
    assert.equal(proc.Killed, true)
    await pool.Acquire(Fx.Key, open)
    assert.equal(spawner.Spawned.length, 2)
    pool.CloseAll()
})

test('with two leases, releasing one keeps the tunnel alive; Release is idempotent', async (t) =>
{
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const spawner = new FakeSpawner()
    const pool = new ClusterTunnelPool()
    const open = Fx.Open(spawner)
    const first = await pool.Acquire(Fx.Key, open)
    const second = await pool.Acquire(Fx.Key, open)
    first.Release()
    first.Release()
    t.mock.timers.tick(Fx.IdleMs * 2)
    assert.equal(spawner.Spawned[0].process.Killed, false)
    second.Release()
    t.mock.timers.tick(Fx.IdleMs)
    assert.equal(spawner.Spawned[0].process.Killed, true)
    pool.CloseAll()
})

test('an Acquire during the idle countdown cancels it', async (t) =>
{
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const spawner = new FakeSpawner()
    const pool = new ClusterTunnelPool()
    const open = Fx.Open(spawner)
    const idle = await pool.Acquire(Fx.Key, open)
    idle.Release()
    t.mock.timers.tick(Fx.IdleMs - 1)
    const held = await pool.Acquire(Fx.Key, open)
    t.mock.timers.tick(Fx.IdleMs * 2)
    assert.equal(spawner.Spawned[0].process.Killed, false)
    assert.equal(spawner.Spawned.length, 1)
    held.Release()
    pool.CloseAll()
})

test('a tunnel whose process exits is dropped so the next Acquire reopens it', async () =>
{
    const spawner = new FakeSpawner()
    const pool = new ClusterTunnelPool()
    const open = Fx.Open(spawner)
    await pool.Acquire(Fx.Key, open)
    spawner.Spawned[0].process.Exit()
    await pool.Acquire(Fx.Key, open)
    assert.equal(spawner.Spawned.length, 2)
    pool.CloseAll()
})

test('a failed open is not cached: the next Acquire tries again', async () =>
{
    const spawner = new FakeSpawner()
    const pool = new ClusterTunnelPool()
    await assert.rejects(pool.Acquire(Fx.Key, () => Promise.reject(new PortForwardError())), PortForwardError)
    assert.equal((await pool.Acquire(Fx.Key, Fx.Open(spawner))).LocalPort, Fx.LocalPort)
    pool.CloseAll()
})

test('CloseAll kills every open tunnel; acquires waiting on a tunnel still opening reject and it is killed once it lands', async () =>
{
    const spawner = new FakeSpawner()
    const pool = new ClusterTunnelPool()
    await pool.Acquire(Fx.Key, Fx.Open(spawner))
    const open = Fx.Open(spawner, Fx.OtherTarget)
    const pending = [pool.Acquire(Fx.OtherKey, open), pool.Acquire(Fx.OtherKey, open)]
    pool.CloseAll()
    assert.equal(spawner.Spawned[0].process.Killed, true)
    for (const p of pending)
    {
        await assert.rejects(p, (err: Error) => err instanceof TunnelPoolClosedError && err.message === TunnelPoolClosedError.DefaultMessage)
    }
    assert.equal(spawner.Spawned[1].process.Killed, true)
})
