import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EffectiveRegistry } from '../effective-registry.js'
import { InfraMode } from '../platform-records.js'
import type { HiveRecord, RegistrySpec } from '../platform-records.js'

class HiveFactory
{
    private static readonly BaseImage = 'pragmatic-server:dev'

    public static get Image(): string
    {
        return HiveFactory.BaseImage
    }

    public static Make(registry: RegistrySpec): HiveRecord
    {
        return {
            id: 'hive-1',
            tenantId: 'tenant-1',
            displayName: 'Hive',
            cluster: { mode: InfraMode.Provision },
            registry,
            createdAt: '2026-10-22T00:00:00.000Z'
        } as HiveRecord
    }
}

describe('EffectiveRegistry', () =>
{
    it('defaults a provision hive to the local registry', () =>
    {
        const reg = EffectiveRegistry.For(HiveFactory.Make({ mode: InfraMode.Provision }))
        assert.equal(reg.Endpoint, 'localhost:5000')
        assert.equal(reg.Mode, InfraMode.Provision)
        assert.equal(reg.ImageRef(HiveFactory.Image), 'localhost:5000/pragmatic-server:dev')
    })

    it('uses an explicit provision endpoint', () =>
    {
        const reg = EffectiveRegistry.For(HiveFactory.Make({ mode: InfraMode.Provision, endpoint: 'reg.local:6000' }))
        assert.equal(reg.ImageRef(HiveFactory.Image), 'reg.local:6000/pragmatic-server:dev')
    })

    it('prefixes an attach endpoint that has a path', () =>
    {
        const reg = EffectiveRegistry.For(HiveFactory.Make({ mode: InfraMode.Attach, endpoint: 'ghcr.io/pragmatic-tech-ai' }))
        assert.equal(reg.Mode, InfraMode.Attach)
        assert.equal(reg.ImageRef(HiveFactory.Image), 'ghcr.io/pragmatic-tech-ai/pragmatic-server:dev')
    })

    it('leaves the image unchanged for an explicitly empty endpoint (shared-store)', () =>
    {
        const reg = EffectiveRegistry.For(HiveFactory.Make({ mode: InfraMode.Provision, endpoint: '' }))
        assert.equal(reg.Endpoint, undefined)
        assert.equal(reg.ImageRef(HiveFactory.Image), 'pragmatic-server:dev')
    })

    it('leaves the image unchanged for an attach hive without an endpoint', () =>
    {
        const reg = EffectiveRegistry.For(HiveFactory.Make({ mode: InfraMode.Attach }))
        assert.equal(reg.Endpoint, undefined)
        assert.equal(reg.ImageRef(HiveFactory.Image), 'pragmatic-server:dev')
    })

    it('trims one trailing slash so ImageRef composes a single separator', () =>
    {
        const slashed = EffectiveRegistry.For(HiveFactory.Make({ mode: InfraMode.Attach, endpoint: 'ghcr.io/org/' }))
        const plain = EffectiveRegistry.For(HiveFactory.Make({ mode: InfraMode.Attach, endpoint: 'ghcr.io/org' }))
        assert.equal(slashed.ImageRef('img'), 'ghcr.io/org/img')
        assert.equal(plain.ImageRef('img'), 'ghcr.io/org/img')
    })
})
