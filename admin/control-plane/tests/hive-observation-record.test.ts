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
