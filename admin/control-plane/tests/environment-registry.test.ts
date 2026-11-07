import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvironmentRegistry } from '../environment-registry.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord, type IContainerProbe } from '../environment-record.js'
import { WriteGate } from './write-gate.js'

class FakeProbe implements IContainerProbe
{
    public readonly State = new Map<string, boolean>()

    public async Running(containerName: string): Promise<boolean>
    {
        return this.State.get(containerName) ?? false
    }
}

/** A registry whose file writes go through a WriteGate, so a test can hold one and see the order they ran in. */
class HeldWriteRegistry extends EnvironmentRegistry
{
    public readonly Gate = new WriteGate()

    protected override WriteFile(body: object): Promise<void>
    {
        return this.Gate.Around(() => super.WriteFile(body))
    }
}

class RegistryFixture
{
    public static readonly Encoding = 'utf8'

    public static Record(name: string, port: number, status: EnvStatus): EnvironmentRecord
    {
        return {
            name,
            type: EnvType.Development,
            template: Template.DevBlank,
            environmentId: `tenant-${name}`,
            hostPort: port,
            containerName: `c-${name}`,
            volumeName: `v-${name}`,
            bundleDir: `/bundles/${name}`,
            createdAt: '2026-10-16T00:00:00.000Z',
            status
        }
    }
}

test('persists, reconciles, and removes records', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), 'envreg-'))
    const file = join(dir, 'sub', 'envs.json')
    try
    {
        const probe = new FakeProbe()
        const a = RegistryFixture.Record('a', 8081, EnvStatus.Unknown)
        const b = RegistryFixture.Record('b', 8082, EnvStatus.Running)
        const c = RegistryFixture.Record('c', 8083, EnvStatus.Failed)

        const first = new EnvironmentRegistry(file, probe)
        await first.Load()
        await first.Put(a)
        await first.Put(b)

        const second = new EnvironmentRegistry(file, probe)
        await second.Load()
        assert.equal(second.List().length, 2)
        assert.deepEqual(second.Get('a'), a)
        assert.deepEqual(second.Get('b'), b)

        await second.Put(c)
        probe.State.set('c-a', true)
        probe.State.set('c-b', false)
        probe.State.set('c-c', true)
        await second.Reconcile()
        assert.equal(second.Get('a')?.status, EnvStatus.Running)
        assert.equal(second.Get('b')?.status, EnvStatus.Stopped)
        assert.equal(second.Get('c')?.status, EnvStatus.Failed)

        const third = new EnvironmentRegistry(file, probe)
        await third.Load()
        assert.equal(third.Get('a')?.status, EnvStatus.Running)
        assert.equal(third.Get('c')?.status, EnvStatus.Failed)

        await third.Remove('b')
        const fourth = new EnvironmentRegistry(file, probe)
        await fourth.Load()
        assert.equal(fourth.Get('b'), undefined)
        assert.ok(fourth.Get('a'))
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('Put and Reconcile do not alias caller records', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), 'envreg-'))
    try
    {
        const probe = new FakeProbe()
        const reg = new EnvironmentRegistry(join(dir, 'envs.json'), probe)
        const mine = RegistryFixture.Record('a', 8081, EnvStatus.Unknown)
        await reg.Put(mine)
        const held = reg.Get('a')
        probe.State.set('c-a', true)
        await reg.Reconcile()
        assert.equal(mine.status, EnvStatus.Unknown)
        assert.equal(held?.status, EnvStatus.Unknown)
        assert.equal(reg.Get('a')?.status, EnvStatus.Running)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('missing file loads as empty', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), 'envreg-'))
    try
    {
        const reg = new EnvironmentRegistry(join(dir, 'none.json'), new FakeProbe())
        await reg.Load()
        assert.equal(reg.List().length, 0)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('Load normalizes a legacy record with no type to Development', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), 'envreg-'))
    const file = join(dir, 'envs.json')
    try
    {
        const legacy: Record<string, unknown> = { ...RegistryFixture.Record('old', 8090, EnvStatus.Running) }
        delete legacy.type
        await writeFile(file, JSON.stringify({ environments: { old: legacy } }), RegistryFixture.Encoding)
        const reg = new EnvironmentRegistry(file, new FakeProbe())
        await reg.Load()
        assert.equal(reg.Get('old')!.type, EnvType.Development)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('a record with an explicit type round-trips through persist/Load', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), 'envreg-'))
    const file = join(dir, 'envs.json')
    try
    {
        const probe = new FakeProbe()
        const first = new EnvironmentRegistry(file, probe)
        await first.Put({ ...RegistryFixture.Record('rt', 8091, EnvStatus.Running), type: EnvType.Runtime })
        const second = new EnvironmentRegistry(file, probe)
        await second.Load()
        assert.equal(second.Get('rt')!.type, EnvType.Runtime)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('concurrent Puts are written one at a time and the file ends with every record', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), 'envreg-'))
    const file = join(dir, 'envs.json')
    try
    {
        const probe = new FakeProbe()
        const reg = new HeldWriteRegistry(file, probe)
        reg.Gate.Hold()
        const putA = reg.Put(RegistryFixture.Record('a', 8081, EnvStatus.Running))
        const putB = reg.Put(RegistryFixture.Record('b', 8082, EnvStatus.Running))
        await WriteGate.Settle()
        assert.deepEqual(reg.Gate.Events, [WriteGate.Start(1)])
        reg.Gate.Release()
        await Promise.all([putA, putB])
        assert.deepEqual(reg.Gate.Events, [WriteGate.Start(1), WriteGate.End(1), WriteGate.Start(2), WriteGate.End(2)])
        const reopened = new EnvironmentRegistry(file, probe)
        await reopened.Load()
        assert.deepEqual(reopened.List().map(r => r.name).sort(), ['a', 'b'])
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('Reconcile leaves a hive-bound Running record untouched even when the docker probe says not running', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), 'envreg-'))
    try
    {
        const probe = new FakeProbe()
        const reg = new EnvironmentRegistry(join(dir, 'envs.json'), probe)
        await reg.Put({ ...RegistryFixture.Record('a', 8081, EnvStatus.Running), hiveId: 'h1' })
        await reg.Put(RegistryFixture.Record('b', 8082, EnvStatus.Running))
        await reg.Reconcile()
        assert.equal(reg.Get('a')?.status, EnvStatus.Running)
        assert.equal(reg.Get('b')?.status, EnvStatus.Stopped)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('HasEnvironmentsOf is true only for a tenant that owns a record', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), 'envreg-'))
    try
    {
        const reg = new EnvironmentRegistry(join(dir, 'envs.json'), new FakeProbe())
        await reg.Put({ ...RegistryFixture.Record('a', 8081, EnvStatus.Running), tenantId: 't1' })
        await reg.Put(RegistryFixture.Record('b', 8082, EnvStatus.Running))
        assert.equal(reg.HasEnvironmentsOf('t1'), true)
        assert.equal(reg.HasEnvironmentsOf('t2'), false)
        assert.equal(reg.HasEnvironmentsOf(''), false)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('HasEnvironmentsOf does not count a failed record', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), 'envreg-'))
    try
    {
        const reg = new EnvironmentRegistry(join(dir, 'envs.json'), new FakeProbe())
        await reg.Put({ ...RegistryFixture.Record('a', 8081, EnvStatus.Failed), tenantId: 't1' })
        assert.equal(reg.HasEnvironmentsOf('t1'), false)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('HasEnvironmentsOf counts a running record beside a failed one, and a stopped or unknown one', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), 'envreg-'))
    try
    {
        const reg = new EnvironmentRegistry(join(dir, 'envs.json'), new FakeProbe())
        await reg.Put({ ...RegistryFixture.Record('a', 8081, EnvStatus.Failed), tenantId: 't1' })
        await reg.Put({ ...RegistryFixture.Record('b', 8082, EnvStatus.Running), tenantId: 't1' })
        await reg.Put({ ...RegistryFixture.Record('c', 8083, EnvStatus.Stopped), tenantId: 't2' })
        await reg.Put({ ...RegistryFixture.Record('d', 8084, EnvStatus.Unknown), tenantId: 't3' })
        assert.equal(reg.HasEnvironmentsOf('t1'), true)
        assert.equal(reg.HasEnvironmentsOf('t2'), true)
        assert.equal(reg.HasEnvironmentsOf('t3'), true)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})
