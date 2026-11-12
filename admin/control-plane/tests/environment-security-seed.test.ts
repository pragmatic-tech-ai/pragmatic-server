import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { EnvironmentSecuritySeed } from '../environment-security-seed.js'

test('seed assigns the creator system administrator in the root unit', () =>
{
    const model = EnvironmentSecuritySeed.For('acme-prod', 'p-1')
    const root = EnvironmentSecuritySeed.RootBusinessUnitId
    assert.deepEqual(model, {
        businessUnits: [{ id: root, name: 'acme-prod' }],
        users: [{ principalId: 'p-1', businessUnitId: root }],
        teams: [],
        roleAssignments: [{ role: 'SystemAdministrator', principalIds: ['p-1'], teamIds: [] }],
        profileAssignments: [],
        roleOverrides: [],
        profileOverrides: []
    })
})
