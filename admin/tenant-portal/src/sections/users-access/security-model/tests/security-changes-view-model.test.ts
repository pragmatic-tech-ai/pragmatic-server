import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SecurityChangesDto } from '../../../../tenant-types.js'
import { FakeTenantApi, TenantTestHost } from '../../../../shell/tests/tenant-test-fixtures.js'
import { SecurityChangesViewModel } from '../security-changes-view-model.js'

class Fixture
{
    public static Change(at: string, patch: Partial<SecurityChangesDto> = {}): SecurityChangesDto
    {
        return {
            at, delivery: 'projects', version: '1.0.0', roleDefaults: [], profileDefaults: [], securedFieldsAdded: [], securedFieldsRemoved: [],
            roleOverridesDropped: [], profileOverridesDropped: [], rolesRemoved: [], profilesRemoved: [], ...patch,
        }
    }

    public static async Load(...changes: SecurityChangesDto[]): Promise<SecurityChangesViewModel>
    {
        const api = new FakeTenantApi()
        api.WithEnvironment('alpha')
        api.SecurityChanges.set('alpha', changes)
        const host = new TenantTestHost(api, { envs: true, adopt: true, access: true, settings: true })
        const vm = new SecurityChangesViewModel(host.Session, { Environment: 'alpha' })
        await vm.Refresh()
        return vm
    }
}

describe('SecurityChangesViewModel', () =>
{
    it('changes list shows a dropped override in plain words', async () =>
    {
        const vm = await Fixture.Load(Fixture.Change('2026-03-04T05:06:07.000Z', {
            version: '2.0.0',
            roleOverridesDropped: [{ role: 'BasicUser', concept: 'projects.Project', action: 'read', level: 'user' }],
        }))
        const entry = vm.Entries.ToArray()[0]
        assert.equal(entry.HeadingText, 'projects 2.0.0, 2026-03-04 05:06 UTC')
        assert.deepEqual(entry.Lines, ['BasicUser: your override of read on projects.Project was dropped'])
    })

    it('secured flag removal is called out', async () =>
    {
        const vm = await Fixture.Load(Fixture.Change('2026-03-04T00:00:00.000Z', { securedFieldsRemoved: [{ concept: 'hr.Employee', field: 'Salary' }] }))
        assert.deepEqual(vm.Entries.ToArray()[0].Lines, ['hr.Employee.Salary is no longer secured: everyone who can read the record can read it'])
    })

    it('changes are newest first', async () =>
    {
        const vm = await Fixture.Load(
            Fixture.Change('2026-01-01T00:00:00.000Z', { version: '1.0.0' }),
            Fixture.Change('2026-03-01T00:00:00.000Z', { version: '3.0.0' }),
            Fixture.Change('2026-02-01T00:00:00.000Z', { version: '2.0.0' }))
        assert.deepEqual(vm.Entries.ToArray().map(e => e.Change.version), ['3.0.0', '2.0.0', '1.0.0'])
    })
})
