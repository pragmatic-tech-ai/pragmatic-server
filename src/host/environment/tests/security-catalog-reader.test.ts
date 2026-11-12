import { before, after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'
import { BaseRole } from '@pragmatic-tech-ai/todl-identity'
import { SecurityRoleKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { PrivilegeDto, SecurityRoleDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { SecurityCatalogReader } from '../security-catalog-reader.js'
import { EnvironmentFixture } from './environment-fixture.js'
import { Tier1Fx } from './tier1-fixture.js'

class ReaderFx
{
    public static Role(roles: readonly SecurityRoleDto[], name: string): SecurityRoleDto
    {
        const role = roles.find(r => r.name === name)
        assert.ok(role !== undefined, `role ${name} is listed`)
        return role
    }

    public static Has(defaults: readonly PrivilegeDto[], concept: string, action: string, level: string): void
    {
        assert.ok(defaults.some(d => d.concept === concept && d.action === action && d.level === level), `${concept}.${action} = ${level}`)
    }
}

describe('security catalog reader', () =>
{
    const fx = new EnvironmentFixture()
    let catalog: IEnvironmentCatalog

    before(async () =>
    {
        for (const [ref, todl] of [[Tier1Fx.Hr, Tier1Fx.HrTodl], [Tier1Fx.Projects, Tier1Fx.ProjectsTodl], [Tier1Fx.Crm, Tier1Fx.CrmTodl], [Tier1Fx.Ext, Tier1Fx.ExtTodl]] as const)
        {
            await fx.Package(ref.id, ref.version, todl)
        }
        fx.Live(Tier1Fx.AppName, Tier1Fx.AppVersion, [Tier1Fx.Hr, Tier1Fx.Projects, Tier1Fx.Crm, Tier1Fx.Ext])
        catalog = (await fx.Host().Snapshot()).Catalog
    })

    after(() => fx.Dispose())

    test('catalog lists base roles first, then package roles sorted by name', () =>
    {
        const roles = SecurityCatalogReader.Read(catalog).roles
        assert.deepEqual(roles.slice(0, 3).map(r => r.name), [BaseRole.SystemAdministrator, BaseRole.BasicUser, BaseRole.Reader])
        assert.ok(roles.slice(0, 3).every(r => r.kind === SecurityRoleKind.Base))
        const packageRoles = roles.slice(3)
        assert.ok(packageRoles.every(r => r.kind === SecurityRoleKind.Package && typeof r.package === 'string' && r.package.length > 0))
        assert.deepEqual(packageRoles.map(r => r.name), [Tier1Fx.AccountReader, Tier1Fx.ProjectManager, Tier1Fx.TaskEditor, Tier1Fx.TaskLinker])
        assert.equal(ReaderFx.Role(roles, Tier1Fx.ProjectManager).package, catalog.HomeModels.get(Tier1Fx.Project))
    })

    test('System Administrator has no defaults; the base roles carry the union of package contributions', () =>
    {
        const roles = SecurityCatalogReader.Read(catalog).roles
        assert.deepEqual(ReaderFx.Role(roles, BaseRole.SystemAdministrator).defaults, [])
        // hr and projects both contribute to BasicUser
        const basicUser = ReaderFx.Role(roles, BaseRole.BasicUser).defaults
        ReaderFx.Has(basicUser, Tier1Fx.Employee, 'read', 'businessUnit')
        ReaderFx.Has(basicUser, Tier1Fx.Project, 'read', 'user')
        ReaderFx.Has(basicUser, Tier1Fx.Task, 'read', 'user')
        // Reader only reads hr.Employee at organisation depth
        ReaderFx.Has(ReaderFx.Role(roles, BaseRole.Reader).defaults, Tier1Fx.Employee, 'read', 'organization')
    })

    test('external concepts are not listed; an organisation-owned concept is marked', () =>
    {
        const concepts = SecurityCatalogReader.Read(catalog).concepts
        const byName = new Map(concepts.map(c => [c.name, c]))
        assert.equal(byName.has(Tier1Fx.Customer), false, 'the connector-bound concept is not engine-stored')
        assert.equal(byName.has('ext.Vendor'), false)
        assert.ok(concepts.every(c => !c.name.startsWith('todl.')), 'platform concepts are excluded')
        assert.equal(byName.get(Tier1Fx.Employee)?.owned, true, 'hr.Employee IsA todl.system.Owned')
        assert.equal(byName.get(Tier1Fx.Account)?.owned, false, 'crm.Account is not owned')
        assert.equal(byName.get(Tier1Fx.Employee)?.package, catalog.HomeModels.get(Tier1Fx.Employee))
    })

    test('secured fields and profiles are the union over packages, sorted', () =>
    {
        const read = SecurityCatalogReader.Read(catalog)
        assert.deepEqual(read.securedFields, [
            { concept: Tier1Fx.Employee, field: Tier1Fx.Salary },
            { concept: Tier1Fx.Project, field: 'budget' },
        ])
        assert.deepEqual(read.profiles.map(p => p.name), [Tier1Fx.Compensation, Tier1Fx.Staffing])
        const compensation = read.profiles.find(p => p.name === Tier1Fx.Compensation)!
        assert.deepEqual(compensation.defaults, [{ concept: Tier1Fx.Employee, field: Tier1Fx.Salary, read: true, update: false, create: false }])
    })
})

describe('security catalog reader on an empty environment', () =>
{
    const fx = new EnvironmentFixture()
    const Empty = { id: 'empty', version: '1.0.0' }
    let catalog: IEnvironmentCatalog

    before(async () =>
    {
        await fx.Package(Empty.id, Empty.version, 'namespace empty { }\n')
        fx.Live('bare', '1.0.0', [Empty])
        catalog = (await fx.Host().Snapshot()).Catalog
    })

    after(() => fx.Dispose())

    test('lists the three base roles and no concepts', () =>
    {
        const read = SecurityCatalogReader.Read(catalog)
        assert.deepEqual(read.roles.map(r => r.name), [BaseRole.SystemAdministrator, BaseRole.BasicUser, BaseRole.Reader])
        assert.ok(read.roles.every(r => r.kind === SecurityRoleKind.Base && r.defaults.length === 0))
        assert.deepEqual(read.concepts, [])
        assert.deepEqual(read.securedFields, [])
        assert.deepEqual(read.profiles, [])
    })
})
