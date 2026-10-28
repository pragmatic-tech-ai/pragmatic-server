import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RoleHoldersDeriver } from '../src/role-holders.js'
import type { RoleAssignmentDto, TeamDto } from '../src/tenant-types.js'

class Fixtures
{
    public static readonly Role = 'role-a'
    public static readonly Other = 'role-b'

    public static Teams(): TeamDto[]
    {
        return [{ id: 't1', name: 'Sales Team' }]
    }

    public static Full(): RoleAssignmentDto
    {
        return {
            claimsMapping: [{ claim: 'group', value: 'admins', roles: [Fixtures.Role] }, { claim: 'group', value: 'x', roles: [Fixtures.Other] }],
            overrides: [{ principalId: 'p1', roles: [Fixtures.Role] }, { principalId: 'p2', roles: [Fixtures.Role, Fixtures.Other] }, { principalId: 'p3', roles: [Fixtures.Other] }],
            teamRoles: [{ teamId: 't1', roles: [Fixtures.Role] }]
        }
    }
}

describe('RoleHoldersDeriver', () =>
{
    it('collects principals, claims and teams for a role', () =>
    {
        const h = RoleHoldersDeriver.Holders(Fixtures.Role, Fixtures.Full(), Fixtures.Teams())
        assert.equal(h.directCount, 2)
        assert.deepEqual(h.byPrincipal, ['p1', 'p2'])
        assert.equal(h.byClaim.length, 1)
        assert.deepEqual(h.byClaim[0], { claim: 'group', value: 'admins' })
        assert.equal(h.byTeam.length, 1)
        assert.deepEqual(h.byTeam[0], { teamId: 't1', teamName: 'Sales Team' })
    })

    it('reports zero direct holders when only claim and team grant the role', () =>
    {
        const a: RoleAssignmentDto = {
            claimsMapping: [{ claim: 'g', value: 'v', roles: [Fixtures.Role] }],
            overrides: [],
            teamRoles: [{ teamId: 't1', roles: [Fixtures.Role] }]
        }
        const h = RoleHoldersDeriver.Holders(Fixtures.Role, a, Fixtures.Teams())
        assert.equal(h.directCount, 0)
        assert.equal(h.byPrincipal.length, 0)
        assert.equal(h.byClaim.length, 1)
        assert.equal(h.byTeam.length, 1)
    })

    it('falls back to the team id when the team is gone', () =>
    {
        const a: RoleAssignmentDto = { claimsMapping: [], overrides: [], teamRoles: [{ teamId: 'gone', roles: [Fixtures.Role] }] }
        const h = RoleHoldersDeriver.Holders(Fixtures.Role, a, [])
        assert.equal(h.byTeam[0].teamName, 'gone')
    })

    it('returns empty for an undefined assignment', () =>
    {
        const h = RoleHoldersDeriver.Holders(Fixtures.Role, undefined, Fixtures.Teams())
        assert.equal(h.directCount, 0)
        assert.equal(h.byPrincipal.length + h.byClaim.length + h.byTeam.length, 0)
    })
})
