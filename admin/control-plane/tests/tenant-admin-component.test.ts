import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TenantAdminComponent } from '../tenant-admin-component.js'
import { ComponentGolden } from '../../../src/component/tests/component-golden.js'
import { ComponentSources } from '../../../src/component/tests/component-sources.js'

class TenantAdminComponentFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Golden = join(TenantAdminComponentFixture.Here, 'fixtures', 'pragmatic-tenant-admin.component.json')
    public static readonly Digest = 'sha256:40866e15b007b409963c5679f37e309bb93283eafa7546217258303dafd2053e'
    public static readonly Readers = [['..', 'tenant-admin-env.ts']].map(path => join(TenantAdminComponentFixture.Here, ...path))
    public static readonly Undeclared: readonly string[] = []
}

describe('TenantAdminComponent', () =>
{
    it('pins the descriptor: golden JSON and content digest', () =>
    {
        ComponentGolden.Check(TenantAdminComponent.Descriptor(), TenantAdminComponentFixture.Golden, TenantAdminComponentFixture.Digest)
    })

    it('declares exactly the variables its configuration readers read', () =>
    {
        ComponentSources.AssertCovers(TenantAdminComponent.Descriptor(), TenantAdminComponentFixture.Readers, TenantAdminComponentFixture.Undeclared)
    })

    it('is named for its release image', () =>
    {
        assert.equal(TenantAdminComponent.Descriptor().Name, 'pragmatic-tenant-admin')
    })
})
