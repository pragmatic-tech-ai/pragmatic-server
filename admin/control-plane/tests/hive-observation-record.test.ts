import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HiveObservationRegistry } from '../hive-observation-record.js'
import type { HiveHealthDto } from '../hive-health-producer.js'

class SeriesFixture
{
    public static readonly Prefix = 'hive-series-'
    public static readonly FileName = 'observations.json'
    public static readonly HiveA = 'A'
    public static readonly HiveB = 'B'
    public static readonly Overflow = 55
    public static readonly Cap = 50
    public static readonly Env = 'env'

    public static Snap(detail: string): HiveHealthDto[]
    {
        return [{ environmentName: SeriesFixture.Env, ready: true, runningImage: undefined, detail }]
    }

    public static async WithStore(body: (registry: HiveObservationRegistry) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), SeriesFixture.Prefix))
        try
        {
            await body(new HiveObservationRegistry(join(dir, SeriesFixture.FileName)))
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }
}

test('latest reflects the last snapshot and history is newest-first', async () =>
{
    await SeriesFixture.WithStore(async registry =>
    {
        await registry.RecordSnapshot(SeriesFixture.HiveA, SeriesFixture.Snap('one'))
        await registry.RecordSnapshot(SeriesFixture.HiveA, SeriesFixture.Snap('two'))
        await registry.RecordSnapshot(SeriesFixture.HiveB, SeriesFixture.Snap('other'))
        assert.equal(registry.LatestFor(SeriesFixture.HiveA)[0]!.detail, 'two')
        assert.equal(registry.LatestRecord(SeriesFixture.HiveA)!.environments[0]!.detail, 'two')
        const history = registry.HistoryFor(SeriesFixture.HiveA, 10)
        assert.deepEqual(history.map(r => r.environments[0]!.detail), ['two', 'one'])
        assert.equal(registry.HistoryFor(SeriesFixture.HiveA, 1).length, 1)
        assert.equal(registry.LatestRecord('none'), undefined)
    })
})

test('evicts only the overflowing hive oldest snapshots', async () =>
{
    await SeriesFixture.WithStore(async registry =>
    {
        await registry.RecordSnapshot(SeriesFixture.HiveB, SeriesFixture.Snap('b'))
        for (let i = 0; i < SeriesFixture.Overflow; i++)
        {
            await registry.RecordSnapshot(SeriesFixture.HiveA, SeriesFixture.Snap(String(i)))
        }
        const history = registry.HistoryFor(SeriesFixture.HiveA, 1000)
        assert.equal(history.length, SeriesFixture.Cap)
        assert.equal(history[0]!.environments[0]!.detail, String(SeriesFixture.Overflow - 1))
        assert.equal(history.at(-1)!.environments[0]!.detail, String(SeriesFixture.Overflow - SeriesFixture.Cap))
        assert.equal(registry.HistoryFor(SeriesFixture.HiveB, 10).length, 1)
    })
})

class ReadPathFixture
{
    public static readonly H1 = 'h1'
    public static readonly H2 = 'h2'
    public static readonly Extra = 'extra'
    public static readonly ManyOther = 40
    public static readonly FewOwn = 3
    public static readonly Ten = 10

    public static async CountClonesDuring(read: () => void): Promise<number>
    {
        const original = globalThis.structuredClone
        let count = 0
        globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) =>
        {
            count++
            return original(value, options)
        }) as typeof structuredClone
        try
        {
            read()
        }
        finally
        {
            globalThis.structuredClone = original
        }
        return count
    }
}

test('latest record and history are defensive copies', async () =>
{
    await SeriesFixture.WithStore(async registry =>
    {
        await registry.RecordSnapshot(ReadPathFixture.H1, SeriesFixture.Snap('one'))
        const first = registry.LatestRecord(ReadPathFixture.H1)!
        first.environments.push(...SeriesFixture.Snap(ReadPathFixture.Extra))
        first.environments[0]!.detail = ReadPathFixture.Extra
        const second = registry.LatestRecord(ReadPathFixture.H1)!
        assert.equal(second.environments.length, 1)
        assert.equal(second.environments[0]!.detail, 'one')
        const history = registry.HistoryFor(ReadPathFixture.H1, ReadPathFixture.Ten)
        history[0]!.environments[0]!.detail = ReadPathFixture.Extra
        assert.equal(registry.HistoryFor(ReadPathFixture.H1, ReadPathFixture.Ten)[0]!.environments[0]!.detail, 'one')
    })
})

test('reads are isolated across hives', async () =>
{
    await SeriesFixture.WithStore(async registry =>
    {
        await registry.RecordSnapshot(ReadPathFixture.H1, SeriesFixture.Snap('a'))
        await registry.RecordSnapshot(ReadPathFixture.H2, SeriesFixture.Snap('b'))
        assert.deepEqual(registry.LatestFor(ReadPathFixture.H1).map(e => e.detail), ['a'])
        assert.equal(registry.LatestRecord(ReadPathFixture.H2)!.environments[0]!.detail, 'b')
    })
})

test('history is newest-first and latest is the newest', async () =>
{
    await SeriesFixture.WithStore(async registry =>
    {
        for (const detail of ['x', 'y', 'z'])
        {
            await registry.RecordSnapshot(ReadPathFixture.H1, SeriesFixture.Snap(detail))
        }
        assert.deepEqual(registry.HistoryFor(ReadPathFixture.H1, ReadPathFixture.Ten).map(r => r.environments[0]!.detail), ['z', 'y', 'x'])
        assert.equal(registry.LatestRecord(ReadPathFixture.H1)!.environments[0]!.detail, 'z')
    })
})

test('a per-hive read does not clone other hives records', async () =>
{
    await SeriesFixture.WithStore(async registry =>
    {
        for (let i = 0; i < ReadPathFixture.ManyOther; i++)
        {
            await registry.RecordSnapshot(ReadPathFixture.H2, SeriesFixture.Snap(String(i)))
        }
        for (let i = 0; i < ReadPathFixture.FewOwn; i++)
        {
            await registry.RecordSnapshot(ReadPathFixture.H1, SeriesFixture.Snap(String(i)))
        }
        const clones = await ReadPathFixture.CountClonesDuring(() => { registry.LatestRecord(ReadPathFixture.H1) })
        assert.ok(clones <= ReadPathFixture.FewOwn, `cloned ${clones} records`)
    })
})
