import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ResourceKind, Role } from '@pragmatic-tech-ai/pragmatic-identity'
import { AdminEnums } from '../admin-enums.js'

class AdminEnumsFx
{
    public static readonly RealmName = 'Realm'
    public static readonly PreRenameName = 'Tenant'
}

test('admin kind name "Realm" round-trips to ResourceKind.Realm', () =>
{
    assert.equal(AdminEnums.ResourceKindFromName(AdminEnumsFx.RealmName), ResourceKind.Realm)
    assert.equal(AdminEnums.NameOfResourceKind(ResourceKind.Realm), AdminEnumsFx.RealmName)
})

test('the pre-rename kind name "Tenant" is no longer accepted', () =>
{
    assert.throws(() => AdminEnums.ResourceKindFromName(AdminEnumsFx.PreRenameName))
})

test('role name "Developer" round-trips to Role.Developer', () =>
{
    assert.equal(AdminEnums.RoleFromName('Developer'), Role.Developer)
    assert.equal(AdminEnums.NameOfRole(Role.Developer), 'Developer')
})
