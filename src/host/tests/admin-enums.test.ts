import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import { AdminEnums } from '../admin-enums.js'

class AdminEnumsFx
{
    public static readonly RealmName = 'Realm'
    public static readonly LegacyRealmName = 'Tenant'
}

test('admin kind name "Tenant" is accepted as Realm and named Realm', () =>
{
    assert.equal(AdminEnums.ResourceKindFromName(AdminEnumsFx.LegacyRealmName), ResourceKind.Realm)
    assert.equal(AdminEnums.ResourceKindFromName(AdminEnumsFx.RealmName), ResourceKind.Realm)
    assert.equal(AdminEnums.NameOfResourceKind(ResourceKind.Realm), AdminEnumsFx.RealmName)
})
