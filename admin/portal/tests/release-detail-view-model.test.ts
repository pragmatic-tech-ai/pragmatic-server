import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ReleaseDetailViewModel } from '../src/release-detail-view-model.js'
import { BannerTone } from '../src/kit/index.js'
import type { FleetHiveDto, ManifestDto } from '../src/portal-types.js'

class Fx
{
    public static readonly Image = 'registry/app:1.2.0'
    public static readonly WithdrawnText =
        'This version is withdrawn. Hives stop seeing it as adoptable after their next check-in. Environments already running it keep running it until their tenant adopts another version.'

    public static Manifest(over: object = {}): ManifestDto
    {
        return { id: '1.2.0', image: Fx.Image, notes: 'Faster sync', publishedAt: '2026-10-01T00:00:00.000Z', ...over } as ManifestDto
    }

    public static Hive(id: string, name: string, envs: object[], owned = true): FleetHiveDto
    {
        return {
            id,
            displayName: name,
            tenant: owned ? { id: 't' + id, displayName: 'Tenant ' + id } : null,
            client: owned ? { id: 'c' + id, displayName: 'Client ' + id } : null,
            clusterBackend: 'k8s',
            clusterMode: 'managed',
            lastSeen: null,
            environments: envs,
        } as FleetHiveDto
    }
}

describe('ReleaseDetailViewModel', () =>
{
    it('published manifest with notes yields five ordered profile items and no banner', () =>
    {
        const vm = new ReleaseDetailViewModel(Fx.Manifest(), [])
        assert.deepEqual(vm.Profile.map(i => i.key), ['Version', 'Image', 'Published', 'Status', "What's new"])
        assert.deepEqual(vm.Profile.map(i => i.value), ['1.2.0', Fx.Image, '2026-10-01', 'Published', 'Faster sync'])
        assert.equal(vm.WithdrawnBanner.show, false)
    })

    it('withdrawn manifest shows the warning banner', () =>
    {
        const vm = new ReleaseDetailViewModel(Fx.Manifest({ withdrawn: true }), [])
        assert.equal(vm.Profile[3].value, 'Withdrawn')
        assert.equal(vm.WithdrawnBanner.show, true)
        assert.equal(vm.WithdrawnBanner.tone, BannerTone.Warning)
        assert.equal(vm.WithdrawnBanner.text, Fx.WithdrawnText)
    })

    it('missing or empty notes show (none) and missing publishedAt shows Unknown', () =>
    {
        const a = new ReleaseDetailViewModel(Fx.Manifest({ notes: undefined, publishedAt: undefined }), [])
        assert.equal(a.Profile[4].value, '(none)')
        assert.equal(a.Profile[2].value, 'Unknown')
        const b = new ReleaseDetailViewModel(Fx.Manifest({ notes: '' }), [])
        assert.equal(b.Profile[4].value, '(none)')
    })

    it('adoption rows list envs running the image, excluding undefined and different images', () =>
    {
        const fleet = [
            Fx.Hive('1', 'Hive A', [{ name: 'prod', ready: true, image: Fx.Image, detail: '' }, { name: 'dev', ready: true, detail: '' }]),
            Fx.Hive('2', 'Hive B', [{ name: 'stage', ready: false, image: Fx.Image, detail: '' }, { name: 'old', ready: true, image: 'registry/app:1.0.0', detail: '' }], false),
        ]
        const rows = new ReleaseDetailViewModel(Fx.Manifest(), fleet).AdoptionRows
        assert.deepEqual(rows, [
            { hiveName: 'Hive A', ownerLabel: 'Client 1 / Tenant 1', envName: 'prod', ready: true },
            { hiveName: 'Hive B', ownerLabel: '(unassigned)', envName: 'stage', ready: false },
        ])
    })

    it('adoption rows are empty when no env runs the image', () =>
    {
        const fleet = [Fx.Hive('1', 'Hive A', [{ name: 'prod', ready: true, image: 'other', detail: '' }])]
        assert.equal(new ReleaseDetailViewModel(Fx.Manifest(), fleet).AdoptionRows.length, 0)
    })

    it('Version returns the manifest id', () =>
    {
        assert.equal(new ReleaseDetailViewModel(Fx.Manifest(), []).Version, '1.2.0')
    })
})
