import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EnvironmentsViewModel } from '../src/environments-view-model.js'
import { PillKind } from '../src/kit/pill-kinds.js'
import { EnvStatus, EnvType, Template, TenantEventType } from '../src/tenant-types.js'
import type { CreateEnvironmentParams, EnvironmentDto, HiveHealthDto, IEnvironmentsSource } from '../src/tenant-types.js'

class Make
{
    public static Env(name: string, status: EnvStatus, hiveId = 'h1'): EnvironmentDto
    {
        return { name, template: Template.DevBlank, type: EnvType.Runtime, environmentId: 'id-' + name, hiveId, hostPort: 1, status, createdAt: '', httpUrl: 'http://' + name, wsUrl: '' }
    }

    public static Health(name: string, ready: boolean, image: string | undefined): HiveHealthDto
    {
        return { environmentName: name, ready, runningImage: image, detail: '' }
    }
}

class FakeSource implements IEnvironmentsSource
{
    public Envs: EnvironmentDto[] = []
    public Health = new Map<string, HiveHealthDto[]>()
    public HealthThrows = new Set<string>()
    public Calls: string[] = []
    public ListGate: Array<(envs: EnvironmentDto[]) => void> | undefined

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        if (this.ListGate !== undefined)
        {
            const gate = this.ListGate
            return new Promise<EnvironmentDto[]>(resolve => { gate.push(resolve) })
        }
        return this.Envs
    }

    public async GetHealth(hiveId: string): Promise<HiveHealthDto[]>
    {
        if (this.HealthThrows.has(hiveId))
        {
            throw new Error('boom')
        }
        return this.Health.get(hiveId) ?? []
    }

    public async StartEnvironment(name: string): Promise<EnvironmentDto>
    {
        this.Calls.push('start:' + name)
        return Make.Env(name, EnvStatus.Running)
    }

    public async StopEnvironment(name: string): Promise<EnvironmentDto>
    {
        this.Calls.push('stop:' + name)
        return Make.Env(name, EnvStatus.Stopped)
    }

    public async RestartEnvironment(name: string): Promise<EnvironmentDto>
    {
        this.Calls.push('restart:' + name)
        return Make.Env(name, EnvStatus.Running)
    }

    public async CreateEnvironment(_p: CreateEnvironmentParams): Promise<EnvironmentDto>
    {
        throw new Error('unused')
    }
}

class Fixture
{
    public static Basic(): FakeSource
    {
        const s = new FakeSource()
        s.Envs = [
            Make.Env('alpha', EnvStatus.Running),
            Make.Env('beta', EnvStatus.Stopped),
            Make.Env('gamma', EnvStatus.Running, 'h2'),
        ]
        s.Health.set('h1', [Make.Health('alpha', true, 'reg.io/app:1.2.3'), Make.Health('beta', false, 'plainimage')])
        return s
    }
}

describe('EnvironmentsViewModel', () =>
{
    it('Load joins envs with health', async () =>
    {
        const vm = new EnvironmentsViewModel(Fixture.Basic())
        await vm.Load()
        const [a, b, g] = vm.Rows
        assert.equal(a.StatusPill, PillKind.Running)
        assert.equal(a.HealthPill, PillKind.Healthy)
        assert.equal(a.Version, '1.2.3')
        assert.equal(a.Url, 'http://alpha')
        assert.equal(b.StatusPill, PillKind.Stopped)
        assert.equal(b.HealthPill, PillKind.Failing)
        assert.equal(b.Version, 'plainimage')
        assert.equal(b.Url, undefined)
        assert.equal(g.HealthPill, PillKind.Unknown)
        assert.equal(g.Version, '\u2014')
    })

    it('a throwing GetHealth degrades only that hive', async () =>
    {
        const s = Fixture.Basic()
        s.HealthThrows.add('h1')
        const vm = new EnvironmentsViewModel(s)
        await vm.Load()
        assert.equal(vm.Error, undefined)
        assert.equal(vm.Rows.length, 3)
        assert.equal(vm.Rows[0].HealthPill, PillKind.Unknown)
        assert.equal(vm.Rows[0].Version, '\u2014')
        assert.equal(vm.Rows[0].Url, 'http://alpha')
    })

    it('Filter matches name, id, version', async () =>
    {
        const vm = new EnvironmentsViewModel(Fixture.Basic())
        await vm.Load()
        vm.Filter = 'ALP'
        assert.deepEqual(vm.Rows.map(r => r.Name), ['alpha'])
        vm.Filter = 'id-gam'
        assert.deepEqual(vm.Rows.map(r => r.Name), ['gamma'])
        vm.Filter = '1.2'
        assert.deepEqual(vm.Rows.map(r => r.Name), ['alpha'])
        vm.Filter = ''
        assert.equal(vm.Rows.length, 3)
        assert.equal(vm.AllRows.length, 3)
    })

    it('selection operates over filtered rows', async () =>
    {
        const vm = new EnvironmentsViewModel(Fixture.Basic())
        await vm.Load()
        vm.Filter = 'a'
        vm.SelectAllFiltered()
        assert.deepEqual([...vm.Selected].sort(), ['alpha', 'beta', 'gamma'])
        vm.ClearSelection()
        vm.Filter = 'beta'
        vm.SelectAllFiltered()
        assert.deepEqual([...vm.Selected], ['beta'])
        vm.Toggle('beta')
        assert.equal(vm.Selected.size, 0)
        vm.Toggle('alpha')
        assert.ok(vm.Selected.has('alpha'))
    })

    it('Start/Stop/RestartSelected act on matching rows then clear and reload', async () =>
    {
        const s = Fixture.Basic()
        const vm = new EnvironmentsViewModel(s)
        await vm.Load()
        vm.SelectAllFiltered()
        await vm.StartSelected()
        assert.deepEqual(s.Calls, ['start:beta'])
        assert.equal(vm.Selected.size, 0)
        vm.SelectAllFiltered()
        await vm.StopSelected()
        assert.deepEqual(s.Calls.slice(1), ['stop:alpha', 'stop:gamma'])
        vm.SelectAllFiltered()
        await vm.RestartSelected()
        assert.deepEqual(s.Calls.slice(3), ['restart:alpha', 'restart:gamma'])
    })

    it('overlapping Loads: newer wins', async () =>
    {
        const s = new FakeSource()
        s.ListGate = []
        const vm = new EnvironmentsViewModel(s)
        const first = vm.Load()
        const second = vm.Load()
        await new Promise(r => setTimeout(r, 0))
        s.ListGate[1]([Make.Env('new', EnvStatus.Running)])
        await second
        s.ListGate[0]([Make.Env('old', EnvStatus.Running)])
        await first
        assert.deepEqual(vm.Rows.map(r => r.Name), ['new'])
        assert.equal(vm.Busy, false)
    })

    it('ApplyEvent', async () =>
    {
        const s = Fixture.Basic()
        const vm = new EnvironmentsViewModel(s)
        await vm.Load()
        s.Envs = [Make.Env('alpha', EnvStatus.Stopped)]
        assert.equal(await vm.ApplyEvent({ type: TenantEventType.EnvironmentChanged, environmentName: 'zzz' }), false)
        assert.equal(vm.Rows.length, 3)
        assert.equal(await vm.ApplyEvent({ type: TenantEventType.EnvironmentDeleted, environmentName: 'beta' }), true)
        assert.equal(vm.Rows.length, 1)
        s.Envs = [Make.Env('alpha', EnvStatus.Stopped), Make.Env('n', EnvStatus.Running)]
        assert.equal(await vm.ApplyEvent({ type: TenantEventType.EnvironmentCreated, environmentName: 'n' }), true)
        assert.equal(vm.Rows.length, 2)
        s.Envs = []
        assert.equal(await vm.ApplyEvent({ type: TenantEventType.HealthChanged, environmentName: 'n' }), true)
        assert.equal(vm.Rows.length, 0)
        assert.equal(await vm.ApplyEvent({ type: 'other' as never, environmentName: 'n' }), false)
    })
})
