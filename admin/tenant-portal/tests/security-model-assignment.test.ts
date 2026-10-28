import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SecurityModelDraft } from '../src/security-model-draft.js'
import type { SecurityModelDto } from '../src/tenant-types.js'

class Fixtures
{
    public static Base(): SecurityModelDto
    {
        return {
            businessUnits: [], teams: [], membership: { claimsMapping: [], overrides: [] }, ownershipRules: [],
            roles: [{ id: 'r1', name: 'A', privileges: [] }, { id: 'r2', name: 'B', privileges: [] }]
        }
    }

    public static Shared(): SecurityModelDto
    {
        const m = Fixtures.Base()
        m.roleAssignment = { claimsMapping: [{ claim: 'dept', value: 'x', roles: ['r1', 'r2'] }], overrides: [], teamRoles: [] }
        return m
    }

    public static Profiles(): SecurityModelDto
    {
        const m = Fixtures.Base()
        m.fieldSecurity = {
            securedFields: [], profiles: [{ id: 'p1', name: 'P', grants: [] }],
            profileAssignment: { claimsMapping: [{ claim: 'c', value: 'v', profiles: ['p1', 'p2'] }], overrides: [], teamProfiles: [] }
        }
        return m
    }
}

describe('RoleAssignmentSection', () =>
{
    it('is clean over an unedited model', () =>
    {
        const d = SecurityModelDraft.From(Fixtures.Shared())
        assert.equal(d.RoleAssignment.Dirty, false)
        assert.equal(d.Dirty, false)
    })

    it('adds, edits and removes a claim grant', () =>
    {
        const d = SecurityModelDraft.From(Fixtures.Base())
        d.RoleAssignment.AddClaimGrant('r1')
        const rows = d.RoleAssignment.ClaimGrants('r1')
        assert.equal(rows.length, 1)
        d.RoleAssignment.SetClaim(rows[0].index, 'dept')
        d.RoleAssignment.SetValue(rows[0].index, 'x')
        assert.deepEqual(d.RoleAssignment.ClaimGrants('r1'), [{ index: 0, claim: 'dept', value: 'x' }])
        assert.equal(d.RoleAssignment.ClaimGrants('r2').length, 0)
        assert.equal(d.Dirty, true)
    })

    it('shares a claim rule across roles and drops it when empty', () =>
    {
        const d = SecurityModelDraft.From(Fixtures.Shared())
        d.RoleAssignment.RemoveClaimGrant('r1', 0)
        assert.equal(d.RoleAssignment.ClaimGrants('r1').length, 0)
        assert.equal(d.RoleAssignment.ClaimGrants('r2').length, 1)
        assert.equal(d.Dirty, true)
        d.RoleAssignment.RemoveClaimGrant('r2', 0)
        assert.equal(d.ToDto().roleAssignment?.claimsMapping.length, 0)
    })

    it('adds and removes principal grants with drop-empty', () =>
    {
        const d = SecurityModelDraft.From(Fixtures.Base())
        d.RoleAssignment.AddPrincipalGrant('r1', 'u1')
        d.RoleAssignment.AddPrincipalGrant('r2', 'u1')
        d.RoleAssignment.AddPrincipalGrant('r2', 'u1')
        assert.deepEqual(d.RoleAssignment.PrincipalGrants('r1'), ['u1'])
        d.RoleAssignment.RemovePrincipalGrant('r1', 'u1')
        assert.deepEqual(d.RoleAssignment.PrincipalGrants('r1'), [])
        assert.deepEqual(d.ToDto().roleAssignment?.overrides, [{ principalId: 'u1', roles: ['r2'] }])
        d.RoleAssignment.RemovePrincipalGrant('r2', 'u1')
        assert.deepEqual(d.ToDto().roleAssignment?.overrides ?? [], [])
    })

    it('adds and removes team grants with drop-empty', () =>
    {
        const d = SecurityModelDraft.From(Fixtures.Base())
        d.RoleAssignment.AddTeamGrant('r1', 't1')
        assert.deepEqual(d.RoleAssignment.TeamGrants('r1'), ['t1'])
        d.RoleAssignment.RemoveTeamGrant('r1', 't1')
        assert.deepEqual(d.RoleAssignment.TeamGrants('r1'), [])
        assert.deepEqual(d.ToDto().roleAssignment?.teamRoles ?? [], [])
    })

    it('treats blank principal as a no-op and stays clean', () =>
    {
        const d = SecurityModelDraft.From(Fixtures.Base())
        d.RoleAssignment.AddPrincipalGrant('r1', '')
        d.RoleAssignment.RemovePrincipalGrant('r1', 'nobody')
        d.RoleAssignment.RemoveTeamGrant('r1', 'nobody')
        d.RoleAssignment.RemoveClaimGrant('r1', 5)
        assert.equal(d.Dirty, false)
        assert.equal(d.ToDto().roleAssignment, undefined)
    })

    it('round-trips an absent roleAssignment: net-empty drops it, a kept grant keeps it', () =>
    {
        const a = SecurityModelDraft.From(Fixtures.Base())
        a.RoleAssignment.AddClaimGrant('r1')
        a.RoleAssignment.RemoveClaimGrant('r1', 0)
        assert.equal(a.ToDto().roleAssignment, undefined)
        const b = SecurityModelDraft.From(Fixtures.Base())
        b.RoleAssignment.AddTeamGrant('r1', 't1')
        assert.deepEqual(b.ToDto().roleAssignment?.teamRoles, [{ teamId: 't1', roles: ['r1'] }])
    })

    it('round-trips a present roleAssignment even when empty', () =>
    {
        const m = Fixtures.Base()
        m.roleAssignment = { claimsMapping: [], overrides: [], teamRoles: [] }
        assert.deepEqual(SecurityModelDraft.From(m).ToDto().roleAssignment, m.roleAssignment)
    })

    it('round-trips a grant with an unknown role id untouched', () =>
    {
        const m = Fixtures.Base()
        m.roleAssignment = { claimsMapping: [], overrides: [{ principalId: 'u1', roles: ['ghost'] }], teamRoles: [] }
        const d = SecurityModelDraft.From(m)
        assert.deepEqual(d.RoleAssignment.PrincipalGrants('r1'), [])
        assert.deepEqual(d.ToDto().roleAssignment, m.roleAssignment)
    })
})

describe('ProfileAssignmentSection', () =>
{
    it('shares a claim rule across profiles and drops it when empty', () =>
    {
        const d = SecurityModelDraft.From(Fixtures.Profiles())
        d.ProfileAssignment.RemoveClaimGrant('p1', 0)
        assert.equal(d.ProfileAssignment.ClaimGrants('p2').length, 1)
        d.ProfileAssignment.RemoveClaimGrant('p2', 0)
        assert.equal(d.ToDto().fieldSecurity?.profileAssignment.claimsMapping.length, 0)
        assert.equal(d.Dirty, true)
    })

    it('adds principal and team grants and bootstraps fieldSecurity', () =>
    {
        const d = SecurityModelDraft.From(Fixtures.Base())
        d.ProfileAssignment.AddPrincipalGrant('p1', 'u1')
        d.ProfileAssignment.AddTeamGrant('p1', 't1')
        d.ProfileAssignment.AddClaimGrant('p1')
        assert.deepEqual(d.ProfileAssignment.PrincipalGrants('p1'), ['u1'])
        assert.deepEqual(d.ProfileAssignment.TeamGrants('p1'), ['t1'])
        assert.equal(d.ProfileAssignment.ClaimGrants('p1').length, 1)
        assert.deepEqual(d.ToDto().fieldSecurity?.profileAssignment.teamProfiles, [{ teamId: 't1', profiles: ['p1'] }])
    })

    it('absent fieldSecurity with a net-empty edit drops back out', () =>
    {
        const d = SecurityModelDraft.From(Fixtures.Base())
        d.ProfileAssignment.AddPrincipalGrant('p1', 'u1')
        d.ProfileAssignment.RemovePrincipalGrant('p1', 'u1')
        assert.equal(d.ToDto().fieldSecurity, undefined)
    })

    it('round-trips a grant with an unknown profile id untouched', () =>
    {
        const m = Fixtures.Profiles()
        m.fieldSecurity!.profileAssignment.teamProfiles.push({ teamId: 't9', profiles: ['ghost'] })
        const d = SecurityModelDraft.From(m)
        assert.deepEqual(d.ProfileAssignment.TeamGrants('p1'), [])
        assert.deepEqual(d.ToDto(), m)
    })
})
