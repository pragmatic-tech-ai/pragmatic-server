import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { HiveObservationRegistry } from '../hive-observation-record.js'

describe('HiveObservationRegistry', () =>
{
    const HiveId = 'hive-1'
    const TempPrefix = 'hive-observation-'
    const StoreFile = 'observations.json'
    let dir: string
    let registry: HiveObservationRegistry

    beforeEach(() =>
    {
        dir = mkdtempSync(join(tmpdir(), TempPrefix))
        registry = new HiveObservationRegistry(join(dir, StoreFile))
    })

    afterEach(() =>
    {
        rmSync(dir, { recursive: true, force: true })
    })

    it('records a snapshot and returns it', async () =>
    {
        const envs = [
            { environmentName: 'a', ready: true, runningImage: 'img:1', detail: 'ok' },
            { environmentName: 'b', ready: false, runningImage: 'img:2', detail: 'down' },
        ]
        await registry.RecordSnapshot(HiveId, envs)
        assert.deepEqual(registry.LatestFor(HiveId), envs)
    })

    it('overwrites a prior snapshot without merging', async () =>
    {
        await registry.RecordSnapshot(HiveId, [
            { environmentName: 'a', ready: true, runningImage: 'img:1', detail: '' },
            { environmentName: 'b', ready: true, runningImage: 'img:2', detail: '' },
        ])
        const shorter = [{ environmentName: 'a', ready: false, runningImage: 'img:3', detail: 'x' }]
        await registry.RecordSnapshot(HiveId, shorter)
        assert.deepEqual(registry.LatestFor(HiveId), shorter)
    })

    it('returns an empty list for an unknown hive', () =>
    {
        assert.deepEqual(registry.LatestFor('nope'), [])
    })
})
