import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SecurityModelDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AdminEnumError } from '../admin-enums.js'
import { SecurityModelWire } from '../security-model-wire.js'

class WireFx
{
    public static Dto(): SecurityModelDto
    {
        return {
            businessUnits: [{ id: 'root', name: 'Contoso' }, { id: 'sales', name: 'Sales', parent: 'root' }],
            users: [{ principalId: 'alice', businessUnitId: 'sales' }],
            teams: [{ id: 't1', name: 'Team', businessUnitId: 'sales', idpGroups: ['g1'], manualMembers: ['bob'] }],
            roleAssignments: [{ role: 'BasicUser', principalIds: ['alice'], teamIds: ['t1'] }],
            profileAssignments: [{ profile: 'hr.Compensation', principalIds: [], teamIds: ['t1'] }],
            roleOverrides: [{ role: 'projects.ProjectManager', concept: 'projects.Project', action: 'appendTo', level: 'businessUnitAndChildren' }],
            profileOverrides: [{ profile: 'hr.Compensation', concept: 'hr.Employee', field: 'Salary', read: true, update: false, create: true }],
        }
    }
}

test('round trip is lossless', () =>
{
    const dto = WireFx.Dto()
    assert.deepEqual(SecurityModelWire.ToDto(SecurityModelWire.FromDto(dto)), dto)
})

test('unknown level is refused', () =>
{
    const dto = WireFx.Dto()
    const bad: SecurityModelDto = { ...dto, roleOverrides: [{ ...dto.roleOverrides[0]!, level: 'everywhere' }] }
    assert.throws(() => SecurityModelWire.FromDto(bad), (error: unknown) => error instanceof AdminEnumError)
})
