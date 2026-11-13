import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessLevel, BaseRole, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { SecurityCatalogDto, SecurityModelDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { RuntimeReaderSecurity } from '../runtime-reader-security.js'

class ReaderSecurityFx
{
    public static readonly Admin = 'admin'
    public static readonly Reader = 'env-reader'
    public static readonly DemoUser = 'rep-boston'
    public static readonly Widget = 'smokepromo.Widget'
    public static readonly Gadget = 'smokepromo2.Gadget'
    public static readonly Tenant = 'contoso'
    public static readonly Unit = 'contoso-root'
    public static readonly ChildUnit = 'contoso-east'

    public static Demo(): SecurityModelDto
    {
        const F = ReaderSecurityFx
        return {
            businessUnits: [{ id: F.Unit, name: F.Tenant }, { id: F.ChildUnit, name: 'East', parent: F.Unit }],
            users: [{ principalId: F.DemoUser, businessUnitId: F.ChildUnit }],
            teams: [],
            roleAssignments: [{ role: BaseRole.BasicUser, principalIds: [F.DemoUser], teamIds: [] }],
            profileAssignments: [],
            roleOverrides: [],
            profileOverrides: []
        }
    }

    public static Catalog(...names: string[]): SecurityCatalogDto
    {
        return { roles: [], concepts: names.map(name => ({ name, package: 'p', owned: false })), securedFields: [], profiles: [] }
    }
}

test('the admin becomes System Administrator and each reader a Reader in the root unit; the demo setting is kept', () =>
{
    const F = ReaderSecurityFx
    const model = RuntimeReaderSecurity.Secured(F.Demo(), F.Admin, [F.Reader], [F.Widget])
    assert.deepEqual(model.businessUnits, F.Demo().businessUnits)
    assert.deepEqual(model.users, [
        { principalId: F.DemoUser, businessUnitId: F.ChildUnit },
        { principalId: F.Admin, businessUnitId: F.Unit },
        { principalId: F.Reader, businessUnitId: F.Unit }])
    assert.deepEqual(model.roleAssignments, [
        { role: BaseRole.BasicUser, principalIds: [F.DemoUser], teamIds: [] },
        { role: BaseRole.SystemAdministrator, principalIds: [F.Admin], teamIds: [] },
        { role: BaseRole.Reader, principalIds: [F.Reader], teamIds: [] }])
    assert.deepEqual(model.roleOverrides, [{ role: BaseRole.Reader, concept: F.Widget, action: PrivilegeAction.Read, level: AccessLevel.Organization }])
})

test('no current setting starts from one root unit named after the tenant; no readers means no Reader assignment', () =>
{
    const F = ReaderSecurityFx
    const model = RuntimeReaderSecurity.Secured(undefined, F.Admin, [], [], F.Tenant)
    assert.equal(model.businessUnits.length, 1)
    assert.equal(model.businessUnits[0]!.name, F.Tenant)
    assert.deepEqual(model.roleAssignments, [{ role: BaseRole.SystemAdministrator, principalIds: [F.Admin], teamIds: [] }])
    assert.deepEqual(model.roleOverrides, [])
})

test('applying twice is idempotent and replaces the Reader read overrides with the new concept list', () =>
{
    const F = ReaderSecurityFx
    const once = RuntimeReaderSecurity.Secured(F.Demo(), F.Admin, [F.Reader], [F.Widget])
    const twice = RuntimeReaderSecurity.Secured(once, F.Admin, [F.Reader], [F.Widget, F.Gadget])
    assert.equal(twice.users.filter(u => u.principalId === F.Reader).length, 1)
    assert.equal(twice.roleAssignments.filter(a => a.role === BaseRole.SystemAdministrator).length, 1)
    assert.deepEqual(twice.roleOverrides.map(o => o.concept), [F.Widget, F.Gadget])
})

test('Resolve maps a concept short name to its catalog name and reports the missing ones', () =>
{
    const F = ReaderSecurityFx
    const catalog = F.Catalog(F.Widget, F.Gadget)
    assert.deepEqual(RuntimeReaderSecurity.Resolve(catalog, ['Widget', F.Gadget]), { resolved: [F.Widget, F.Gadget], missing: [] })
    assert.deepEqual(RuntimeReaderSecurity.Resolve(catalog, ['Sprocket']), { resolved: [], missing: ['Sprocket'] })
})
