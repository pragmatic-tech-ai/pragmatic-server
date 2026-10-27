import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EnvironmentDetailViewModel } from '../src/environment-detail-view-model.js'
import type { IEnvDetailSource } from '../src/environment-detail-view-model.js'
import { EnvironmentRow } from '../src/environment-row.js'
import { EnvStatus, EnvType, Template } from '../src/tenant-types.js'
import type { EnvironmentDto, HiveHealthDto } from '../src/tenant-types.js'

class Make
{
    public static Env(status: string): EnvironmentDto
    {
        return { name: 'e1', template: Template.DevBlank, type: EnvType.Runtime, environmentId: 'id1', hiveId: 'h1', hostPort: 1, status: status as EnvStatus, createdAt: '', httpUrl: '', wsUrl: '' }
    }
}

class FakeEnvDetailSource implements IEnvDetailSource
{
    public Calls: string[] = []
    public Result: EnvironmentDto = Make.Env('running')
    public Health: HiveHealthDto[] = [
        { environmentName: 'other', ready: false, runningImage: 'x', detail: 'no' },
        { environmentName: 'e1', ready: true, runningImage: 'img:v1', detail: 'ok' },
    ]
    public HealthCalls = 0
    public Opened = 0
    public DisposeCalls = 0
    public Push: (t: string) => void = () => undefined

    public async StartEnvironment(name: string): Promise<EnvironmentDto>
    {
        this.Calls.push('start:' + name)
        return this.Result
    }

    public async DeleteEnvironment(name: string): Promise<void>
    {
        this.Calls.push('delete:' + name)
    }

    public async StopEnvironment(name: string): Promise<EnvironmentDto>
    {
        this.Calls.push('stop:' + name)
        return this.Result
    }

    public async RestartEnvironment(name: string): Promise<EnvironmentDto>
    {
        this.Calls.push('restart:' + name)
        return this.Result
    }

    public async GetHealth(_hiveId: string): Promise<HiveHealthDto[]>
    {
        this.HealthCalls++
        return this.Health
    }

    public OpenLogStream(_name: string, onChunk: (t: string) => void): () => void
    {
        this.Opened++
        this.Push = onChunk
        return () => { this.DisposeCalls++ }
    }
}

describe('EnvironmentDetailViewModel', () =>
{
    it('lifecycle calls update Status from the returned DTO', async () =>
    {
        const src = new FakeEnvDetailSource()
        const vm = new EnvironmentDetailViewModel(src, Make.Env('stopped'), 'h1')
        assert.equal(vm.Status, 'stopped')
        await vm.Start()
        assert.equal(vm.Status, 'running')
        src.Result = Make.Env('stopped')
        await vm.Stop()
        assert.equal(vm.Status, 'stopped')
        src.Result = Make.Env('running')
        await vm.Restart()
        assert.equal(vm.Status, 'running')
        assert.deepEqual(src.Calls, ['start:e1', 'stop:e1', 'restart:e1'])
    })

    it('LoadHealth picks this env row; undefined hive skips the call', async () =>
    {
        const src = new FakeEnvDetailSource()
        const vm = new EnvironmentDetailViewModel(src, Make.Env('running'), 'h1')
        await vm.LoadHealth()
        assert.equal(vm.Health?.detail, 'ok')
        const unbound = new EnvironmentDetailViewModel(src, Make.Env('running'), undefined)
        const before = src.HealthCalls
        await unbound.LoadHealth()
        assert.equal(unbound.Health, undefined)
        assert.equal(src.HealthCalls, before)
    })

    it('streams chunks, pause drops them without closing, resume appends', () =>
    {
        const src = new FakeEnvDetailSource()
        const vm = new EnvironmentDetailViewModel(src, Make.Env('running'), 'h1')
        vm.StartLogs()
        vm.StartLogs()
        assert.equal(src.Opened, 1)
        src.Push('a')
        assert.equal(vm.LogBuffer, 'a')
        vm.TogglePause()
        assert.equal(vm.Paused, true)
        src.Push('b')
        assert.equal(vm.LogBuffer, 'a')
        assert.equal(src.DisposeCalls, 0)
        vm.TogglePause()
        src.Push('c')
        assert.equal(vm.LogBuffer, 'ac')
    })

    it('bounds the buffer to the last MaxLogChars', () =>
    {
        const src = new FakeEnvDetailSource()
        const vm = new EnvironmentDetailViewModel(src, Make.Env('running'), 'h1')
        vm.StartLogs()
        const max = EnvironmentDetailViewModel.MaxLogChars
        src.Push('x'.repeat(max))
        src.Push('y'.repeat(max + 10) + 'END')
        assert.equal(vm.LogBuffer.length, max)
        assert.ok(vm.LogBuffer.endsWith('yEND'))
        assert.ok(!vm.LogBuffer.includes('x'))
    })

    it('StartLogs after StopLogs stays closed, even when StopLogs came first', () =>
    {
        const src = new FakeEnvDetailSource()
        const early = new EnvironmentDetailViewModel(src, Make.Env('running'), 'h1')
        early.StopLogs()
        early.StartLogs()
        assert.equal(src.Opened, 0)
        const used = new EnvironmentDetailViewModel(src, Make.Env('running'), 'h1')
        used.StartLogs()
        used.StopLogs()
        used.StartLogs()
        assert.equal(src.Opened, 1)
        assert.equal(src.DisposeCalls, 1)
    })

    it('LoadHealth clears Version when the row disappears', async () =>
    {
        const src = new FakeEnvDetailSource()
        const vm = new EnvironmentDetailViewModel(src, Make.Env('running'), 'h1')
        await vm.LoadHealth()
        assert.equal(vm.Version, 'v1')
        src.Health = []
        await vm.LoadHealth()
        assert.equal(vm.Version, EnvironmentRow.VersionOf(undefined))
    })

    it('StopLogs closes the stream once and ignores later chunks', () =>
    {
        const src = new FakeEnvDetailSource()
        const vm = new EnvironmentDetailViewModel(src, Make.Env('running'), 'h1')
        vm.StartLogs()
        src.Push('a')
        vm.StopLogs()
        vm.StopLogs()
        assert.equal(src.DisposeCalls, 1)
        src.Push('late')
        assert.equal(vm.LogBuffer, 'a')
    })

    it('Delete calls the source once with the env name and propagates rejection', async () =>
    {
        const src = new FakeEnvDetailSource()
        const vm = new EnvironmentDetailViewModel(src, Make.Env('running'), 'h1')
        await vm.Delete()
        assert.deepEqual(src.Calls, ['delete:e1'])
        src.DeleteEnvironment = async () => { throw new Error('boom') }
        await assert.rejects(() => vm.Delete(), /boom/)
    })

    it('LiveUrl follows the live status, not the construction status', async () =>
    {
        const src = new FakeEnvDetailSource()
        const env = { ...Make.Env('running'), httpUrl: 'http://x' }
        const vm = new EnvironmentDetailViewModel(src, env, 'h1')
        assert.equal(vm.LiveUrl, 'http://x')
        src.Result = Make.Env('stopped')
        await vm.Stop()
        assert.equal(vm.LiveUrl, '')
        src.Result = Make.Env('running')
        await vm.Start()
        assert.equal(vm.LiveUrl, 'http://x')
    })

    it('Version is the image tag after LoadHealth and the sentinel without an image', async () =>
    {
        const src = new FakeEnvDetailSource()
        const vm = new EnvironmentDetailViewModel(src, Make.Env('running'), 'h1')
        assert.equal(vm.Version, new EnvironmentRow(Make.Env('running')).Version)
        assert.equal(vm.Version, String.fromCharCode(0x2014))
        await vm.LoadHealth()
        assert.equal(vm.Version, 'v1')
        assert.equal(vm.Version, new EnvironmentRow(Make.Env('running'), src.Health[1]).Version)
    })

    it('exposes raw env fields', () =>
    {
        const vm = new EnvironmentDetailViewModel(new FakeEnvDetailSource(), Make.Env('running'), 'h1')
        assert.equal(vm.Name, 'e1')
        assert.equal(vm.Template, Template.DevBlank)
        assert.equal(vm.EnvironmentId, 'id1')
        assert.equal(vm.CreatedAt, '')
    })

})
