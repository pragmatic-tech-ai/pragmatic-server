import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SecurityModelDto } from '../../../../tenant-types.js'
import { SecurityModelDraft } from '../security-model-draft.js'
import { SecurityFixtures } from './security-fixtures.js'

describe('SecurityModelDraft', () =>
{
    it('round trip preserves every section', () =>
    {
        const model = SecurityFixtures.Model()
        const draft = new SecurityModelDraft(model, SecurityFixtures.Catalog())
        const out = draft.ToDto()
        assert.deepEqual(out, SecurityFixtures.Model())
        assert.equal(draft.Dirty, false)
        // Deep-cloned both ways: editing the emitted copy touches neither the input nor the draft.
        out.teams[0].manualMembers.push('mallory')
        assert.deepEqual(model, SecurityFixtures.Model())
        assert.deepEqual(draft.ToDto(), SecurityFixtures.Model())
        // An assignment left with no holders is dropped.
        draft.Assignments.RemovePrincipal('projects.ProjectManager', 'alice')
        draft.Assignments.RemoveTeam('projects.ProjectManager', 'team-a')
        assert.deepEqual(draft.ToDto().roleAssignments, [])
        assert.equal(draft.Dirty, true)
    })

    it('retired sections are not emitted', () =>
    {
        const old = { ...SecurityFixtures.Model(), membership: { claimsMapping: [], overrides: [] }, ownershipRules: [], roles: [], fieldSecurity: {} }
        const draft = new SecurityModelDraft(old as unknown as SecurityModelDto, SecurityFixtures.Catalog())
        assert.deepEqual(Object.keys(draft.ToDto()).sort(),
            ['businessUnits', 'profileAssignments', 'profileOverrides', 'roleAssignments', 'roleOverrides', 'teams', 'users'])
    })
})
