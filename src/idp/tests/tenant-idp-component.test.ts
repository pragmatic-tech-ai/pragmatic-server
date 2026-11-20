import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TenantIdpComponent } from '../tenant-idp-component.js'
import { ComponentGolden } from '../../component/tests/component-golden.js'
import { ComponentSources } from '../../component/tests/component-sources.js'

class TenantIdpComponentFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Golden = join(TenantIdpComponentFixture.Here, 'fixtures', 'pragmatic-tenant-idp.component.json')
    public static readonly Digest = 'sha256:95021d7f98dcf5820ba1fe8a860cb76485a3d618fb77bff464174c4840227a67'
    public static readonly Readers = [['..', 'idp-main.ts'], ['..', 'tenant-idp-database.ts']].map(path => join(TenantIdpComponentFixture.Here, ...path))
    public static readonly Undeclared: readonly string[] = []
}

describe('TenantIdpComponent', () =>
{
    it('pins the descriptor: golden JSON and content digest', () =>
    {
        ComponentGolden.Check(TenantIdpComponent.Descriptor(), TenantIdpComponentFixture.Golden, TenantIdpComponentFixture.Digest)
    })

    it('declares exactly the variables its configuration readers read', () =>
    {
        ComponentSources.AssertCovers(TenantIdpComponent.Descriptor(), TenantIdpComponentFixture.Readers, TenantIdpComponentFixture.Undeclared)
    })

    it('is named for its release image', () =>
    {
        assert.equal(TenantIdpComponent.Descriptor().Name, 'pragmatic-tenant-idp')
    })
})
