import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManifestRegistry, ReleaseState, type ManifestRecord } from '../manifest-record.js'
import { DevPlatformImages, ReleasePlatformImages } from '../platform-images.js'
import { ReleaseApp, ReleaseApps } from '../release/release-tag.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'

class Releases
{
    public static readonly Host = 'ghcr.io'
    public static readonly Namespace = 'pragmatic-tech-ai/'

    public static Digest(fill: string): string
    {
        return 'sha256:' + fill.repeat(64)
    }

    public static Record(id: string, publishedAt: string, fill: string, extra: Partial<ManifestRecord> = {}, state: ReleaseState = ReleaseState.Verified): ManifestRecord
    {
        const images = {} as Record<ReleaseApp, { repository: string; digest: string }>
        for (const app of ReleaseApps.All)
        {
            images[app] = { repository: Releases.Namespace + app, digest: Releases.Digest(fill) }
        }
        return { id, image: '', publishedAt, release: { state, images }, ...extra }
    }

    public static AgentRef(fill: string): string
    {
        return Releases.Host + '/' + Releases.Namespace + ReleaseApp.HiveAgent + '@' + Releases.Digest(fill)
    }

    public static async With(records: ManifestRecord[], body: (images: ReleasePlatformImages) => void): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), 'platform-images-'))
        try
        {
            const manifests = new ManifestRegistry(join(dir, 'manifests.json'))
            await manifests.Load()
            for (const record of records)
            {
                await manifests.Put(record)
            }
            body(new ReleasePlatformImages(manifests, Releases.Host))
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }
}

describe('ReleasePlatformImages', () =>
{
    it('returns the by-digest hive-agent reference of the newest verified release', async () =>
    {
        await Releases.With([
            Releases.Record('0.1.0', '2026-11-01T00:00:00.000Z', 'a'),
            Releases.Record('0.2.0', '2026-11-02T00:00:00.000Z', 'b'),
        ], images => assert.equal(images.ImageOf(ReleaseApp.HiveAgent), Releases.AgentRef('b')))
    })

    it('skips a newer withdrawn release and a newer rejected one', async () =>
    {
        await Releases.With([
            Releases.Record('0.1.0', '2026-11-01T00:00:00.000Z', 'a'),
            Releases.Record('0.2.0', '2026-11-02T00:00:00.000Z', 'b', { withdrawn: true }),
            Releases.Record('0.3.0', '2026-11-03T00:00:00.000Z', 'c', {}, ReleaseState.Rejected),
            { id: 'local-1', image: 'registry/pragmatic-server:1', publishedAt: '2026-11-04T00:00:00.000Z' },
        ], images => assert.equal(images.ImageOf(ReleaseApp.HiveAgent), Releases.AgentRef('a')))
    })

    it('returns undefined with no records', async () =>
    {
        await Releases.With([], images => assert.equal(images.ImageOf(ReleaseApp.HiveAgent), undefined))
    })
})

describe('DevPlatformImages', () =>
{
    it('returns pragmatic-server:dev for every app', () =>
    {
        const images = new DevPlatformImages()
        for (const app of ReleaseApps.All)
        {
            assert.equal(images.ImageOf(app), K8sManifestBuilder.AgentImage)
        }
        assert.equal(K8sManifestBuilder.AgentImage, 'pragmatic-server:dev')
    })
})
