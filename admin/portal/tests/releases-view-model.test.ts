import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ReleasesViewModel } from '../src/releases-view-model.js'
import type { FleetHiveDto, ManifestDto } from '../src/portal-types.js'

class Fx
{
    public static Manifest(id: string, image: string, publishedAt: string, withdrawn?: boolean): ManifestDto
    {
        return { id, image, publishedAt, withdrawn }
    }

    public static Hive(id: string, images: (string | undefined)[]): FleetHiveDto
    {
        return {
            id,
            displayName: 'Hive ' + id,
            tenant: { id: 't', displayName: 'T' },
            client: { id: 'c', displayName: 'C' },
            clusterBackend: 'k8s',
            clusterMode: 'managed',
            lastSeen: null,
            environments: images.map((image, i) => ({ name: 'env' + i, ready: true, image, detail: '' })),
        } as FleetHiveDto
    }
}

describe('ReleasesViewModel', () =>
{
    it('counts observed envs per image', () =>
    {
        const vm = new ReleasesViewModel(
            [Fx.Manifest('m1', 'img1', '2026-01-01T00:00:00Z'), Fx.Manifest('m2', 'img2', '2026-01-02T00:00:00Z')],
            [Fx.Hive('a', ['img1']), Fx.Hive('b', ['img2'])])
        assert.deepEqual(vm.Rows.map(r => r.observedEnvCount), [1, 1])
    })

    it('counts zero when no env runs the image', () =>
    {
        const vm = new ReleasesViewModel([Fx.Manifest('m1', 'img1', '2026-01-01')], [Fx.Hive('a', ['other'])])
        assert.equal(vm.Rows[0].observedEnvCount, 0)
    })

    it('does not match undefined env images', () =>
    {
        const vm = new ReleasesViewModel([Fx.Manifest('m1', 'img1', '2026-01-01')], [Fx.Hive('a', [undefined, undefined])])
        assert.equal(vm.Rows[0].observedEnvCount, 0)
    })

    it('flags withdrawn manifests', () =>
    {
        const vm = new ReleasesViewModel(
            [Fx.Manifest('m1', 'i', '2026-01-01', true), Fx.Manifest('m2', 'j', '2026-01-02')], [])
        const byId = new Map(vm.Rows.map(r => [r.id, r]))
        assert.equal(byId.get('m1')!.withdrawn, true)
        assert.equal(byId.get('m2')!.withdrawn, false)
    })

    it('labels missing publishedAt as Unknown', () =>
    {
        const vm = new ReleasesViewModel([Fx.Manifest('m1', 'i', '')], [])
        assert.equal(vm.Rows[0].publishedLabel, 'Unknown')
    })

    it('labels publishedAt as a date', () =>
    {
        const vm = new ReleasesViewModel([Fx.Manifest('m1', 'i', '2026-03-04T10:00:00Z')], [])
        assert.equal(vm.Rows[0].publishedLabel, '2026-03-04')
    })

    it('orders newest first', () =>
    {
        const vm = new ReleasesViewModel(
            [Fx.Manifest('old', 'i', '2026-01-01T00:00:00Z'), Fx.Manifest('new', 'j', '2026-05-01T00:00:00Z'),
                Fx.Manifest('mid', 'k', '2026-03-01T00:00:00Z')], [])
        assert.deepEqual(vm.Rows.map(r => r.id), ['new', 'mid', 'old'])
    })

    it('Update raises RowsProperty and replaces Rows', () =>
    {
        const vm = new ReleasesViewModel([Fx.Manifest('m1', 'i', '2026-01-01')], [])
        let raised = 0
        vm.PropertyChanged(ReleasesViewModel.RowsProperty).subscribe(() => { raised++ })
        vm.Update([Fx.Manifest('z', 'q', '2026-02-02')], [Fx.Hive('a', ['q'])])
        assert.equal(raised, 1)
        assert.deepEqual(vm.Rows.map(r => r.id), ['z'])
        assert.equal(vm.Rows[0].observedEnvCount, 1)
    })
})
