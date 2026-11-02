import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RoleHoldersDeriver } from '../role-holders.js'
import type { RoleAssignmentDto, TeamDto } from '../../../../tenant-types.js'

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
        assert.equal(h.DirectCount, 2)
        assert.deepEqual(h.ByPrincipal, ['p1', 'p2'])
        assert.equal(h.ByClaim.length, 1)
        assert.deepEqual(h.ByClaim[0], { Claim: 'group', Value: 'admins' })
        assert.equal(h.ByTeam.length, 1)
        assert.deepEqual(h.ByTeam[0], { TeamId: 't1', TeamName: 'Sales Team' })
    })

    it('reports zero direct holders when only claim and team grant the role', () =>
    {
        const a: RoleAssignmentDto = {
            claimsMapping: [{ claim: 'g', value: 'v', roles: [Fixtures.Role] }],
            overrides: [],
            teamRoles: [{ teamId: 't1', roles: [Fixtures.Role] }]
        }
        const h = RoleHoldersDeriver.Holders(Fixtures.Role, a, Fixtures.Teams())
        assert.equal(h.DirectCount, 0)
        assert.equal(h.ByPrincipal.length, 0)
        assert.equal(h.ByClaim.length, 1)
        assert.equal(h.ByTeam.length, 1)
    })

    it('falls back to the team id when the team is gone', () =>
    {
        const a: RoleAssignmentDto = { claimsMapping: [], overrides: [], teamRoles: [{ teamId: 'gone', roles: [Fixtures.Role] }] }
        const h = RoleHoldersDeriver.Holders(Fixtures.Role, a, [])
        assert.equal(h.ByTeam[0].TeamName, 'gone')
    })

    it('returns empty for an undefined assignment', () =>
    {
        const h = RoleHoldersDeriver.Holders(Fixtures.Role, undefined, Fixtures.Teams())
        assert.equal(h.DirectCount, 0)
        assert.equal(h.ByPrincipal.length + h.ByClaim.length + h.ByTeam.length, 0)
    })
})
