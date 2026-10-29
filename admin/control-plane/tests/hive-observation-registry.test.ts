import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HiveObservationRegistry } from '../hive-observation-record.js'
import type { HiveHealthDto } from '../hive-health-producer.js'

class ObservationFixture
{
    public static readonly Prefix = 'hive-observation-'
    public static readonly FileName = 'observations.json'
    public static readonly HiveId = 'hive-1'
    public static readonly UnknownHiveId = 'nope'
    public static readonly EnvA = 'a'
    public static readonly EnvB = 'b'
    public static readonly ImageOne = 'img:1'
    public static readonly ImageTwo = 'img:2'
    public static readonly ImageThree = 'img:3'
    public static readonly DetailOk = 'ok'
    public static readonly DetailDown = 'down'

    public static Env(name: string, ready: boolean, runningImage: string | undefined, detail: string): HiveHealthDto
    {
        return { environmentName: name, ready, runningImage, detail }
    }

    public static async WithStore(body: (file: string, registry: HiveObservationRegistry) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), ObservationFixture.Prefix))
        try
        {
            const file = join(dir, ObservationFixture.FileName)
            await body(file, new HiveObservationRegistry(file))
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }
}

test('records a snapshot and returns it', async () =>
{
    await ObservationFixture.WithStore(async (_file, registry) =>
    {
        const envs = [
            ObservationFixture.Env(ObservationFixture.EnvA, true, ObservationFixture.ImageOne, ObservationFixture.DetailOk),
            ObservationFixture.Env(ObservationFixture.EnvB, false, ObservationFixture.ImageTwo, ObservationFixture.DetailDown),
        ]
        await registry.RecordSnapshot(ObservationFixture.HiveId, envs)
        assert.deepEqual(registry.LatestFor(ObservationFixture.HiveId), envs)
    })
})

test('overwrites a prior snapshot without merging', async () =>
{
    await ObservationFixture.WithStore(async (_file, registry) =>
    {
        await registry.RecordSnapshot(ObservationFixture.HiveId, [
            ObservationFixture.Env(ObservationFixture.EnvA, true, ObservationFixture.ImageOne, ObservationFixture.DetailOk),
            ObservationFixture.Env(ObservationFixture.EnvB, true, ObservationFixture.ImageTwo, ObservationFixture.DetailOk),
        ])
        const shorter = [ObservationFixture.Env(ObservationFixture.EnvA, false, ObservationFixture.ImageThree, ObservationFixture.DetailDown)]
        await registry.RecordSnapshot(ObservationFixture.HiveId, shorter)
        assert.deepEqual(registry.LatestFor(ObservationFixture.HiveId), shorter)
    })
})

test('returns an empty list for an unknown hive', async () =>
{
    await ObservationFixture.WithStore(async (_file, registry) =>
    {
        assert.deepEqual(registry.LatestFor(ObservationFixture.UnknownHiveId), [])
    })
})

test('round-trips through a fresh registry, including an undefined runningImage', async () =>
{
    await ObservationFixture.WithStore(async (file, registry) =>
    {
        const envs = [
            ObservationFixture.Env(ObservationFixture.EnvA, true, ObservationFixture.ImageOne, ObservationFixture.DetailOk),
            ObservationFixture.Env(ObservationFixture.EnvB, false, undefined, ObservationFixture.DetailDown),
        ]
        await registry.RecordSnapshot(ObservationFixture.HiveId, envs)
        const fresh = new HiveObservationRegistry(file)
        await fresh.Load()
        const loaded = fresh.LatestFor(ObservationFixture.HiveId)
        assert.equal(loaded.length, envs.length)
        assert.equal(loaded[0].runningImage, ObservationFixture.ImageOne)
        assert.equal(loaded[1].runningImage, undefined)
        assert.equal(loaded[1].environmentName, ObservationFixture.EnvB)
    })
})

test('stamps reportedAt as a parseable ISO-8601 string', async () =>
{
    await ObservationFixture.WithStore(async (_file, registry) =>
    {
        await registry.RecordSnapshot(ObservationFixture.HiveId, [])
        const reportedAt = registry.LatestRecord(ObservationFixture.HiveId)!.reportedAt
        assert.ok(!Number.isNaN(Date.parse(reportedAt)))
        assert.equal(new Date(reportedAt).toISOString(), reportedAt)
    })
})
