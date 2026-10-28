import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AccessLevel, PrivilegeAction, SecurityModelDraft } from '../src/security-model-draft.js'
import { RecordSharingDeriver } from '../src/record-sharing.js'
import type { OwnershipRuleDto, PrivilegeDto, RoleConfigDto, SecurityModelDto } from '../src/tenant-types.js'

class Fixtures
{
    public static Role(privileges: PrivilegeDto[]): RoleConfigDto
    {
        return { id: 'r1', name: 'Role', privileges }
    }

    public static P(action: PrivilegeAction, concept: string, level: AccessLevel | string): PrivilegeDto
    {
        return { action, concept, level }
    }

    public static Rule(concept: string): OwnershipRuleDto
    {
        return { concept, owningBusinessUnit: { kind: 'fixed', value: 'bu1' } }
    }
}

describe('RecordSharingDeriver', () =>
{
    it('returns no rows for an undefined role', () =>
    {
        assert.deepEqual(RecordSharingDeriver.Rows(undefined, []), [])
    })

    it('lists one row with organization scope and no share or assign', () =>
    {
        const rows = RecordSharingDeriver.Rows(Fixtures.Role([Fixtures.P(PrivilegeAction.Read, 'Account', AccessLevel.Organization)]), [])
        assert.equal(rows.length, 1)
        assert.equal(rows[0].concept, 'Account')
        assert.match(rows[0].scopeText, /organization/)
        assert.equal(rows[0].canShare, false)
        assert.equal(rows[0].canAssign, false)
    })

    it('sets canShare when a share privilege exists', () =>
    {
        const rows = RecordSharingDeriver.Rows(Fixtures.Role([
            Fixtures.P(PrivilegeAction.Read, 'Account', AccessLevel.Organization),
            Fixtures.P(PrivilegeAction.Share, 'Account', AccessLevel.User)
        ]), [])
        assert.equal(rows[0].canShare, true)
        assert.equal(rows[0].canAssign, false)
    })

    it('uses the broadest level across non-share actions', () =>
    {
        const rows = RecordSharingDeriver.Rows(Fixtures.Role([
            Fixtures.P(PrivilegeAction.Read, 'Account', AccessLevel.User),
            Fixtures.P(PrivilegeAction.Update, 'Account', AccessLevel.BusinessUnit)
        ]), [])
        assert.match(rows[0].scopeText, /business unit/)
        assert.doesNotMatch(rows[0].scopeText, /children/)
    })

    it('lists a share/assign-only concept with no direct record access', () =>
    {
        const rows = RecordSharingDeriver.Rows(Fixtures.Role([
            Fixtures.P(PrivilegeAction.Share, 'Lead', AccessLevel.Organization),
            Fixtures.P(PrivilegeAction.Assign, 'Lead', AccessLevel.User)
        ]), [])
        assert.equal(rows.length, 1)
        assert.match(rows[0].scopeText, /no direct record access/)
        assert.equal(rows[0].canShare, true)
        assert.equal(rows[0].canAssign, true)
    })

    it('treats a share privilege at none as absent', () =>
    {
        const rows = RecordSharingDeriver.Rows(Fixtures.Role([
            Fixtures.P(PrivilegeAction.Read, 'Account', AccessLevel.User),
            Fixtures.P(PrivilegeAction.Share, 'Account', AccessLevel.None)
        ]), [])
        assert.equal(rows[0].canShare, false)
    })

    it('appends the ownership clause only when a rule exists', () =>
    {
        const role = Fixtures.Role([
            Fixtures.P(PrivilegeAction.Read, 'Account', AccessLevel.User),
            Fixtures.P(PrivilegeAction.Read, 'Zeta', AccessLevel.User)
        ])
        const rows = RecordSharingDeriver.Rows(role, [Fixtures.Rule('Zeta')])
        assert.doesNotMatch(rows[0].scopeText, /ownership rules/)
        assert.match(rows[1].scopeText, /owned per the ownership rules/)
    })

    it('sorts rows by concept', () =>
    {
        const rows = RecordSharingDeriver.Rows(Fixtures.Role([
            Fixtures.P(PrivilegeAction.Read, 'Zeta', AccessLevel.User),
            Fixtures.P(PrivilegeAction.Read, 'Alpha', AccessLevel.User)
        ]), [])
        assert.deepEqual(rows.map(r => r.concept), ['Alpha', 'Zeta'])
    })

    it('yields generic scope text for an unknown level without throwing', () =>
    {
        const rows = RecordSharingDeriver.Rows(Fixtures.Role([Fixtures.P(PrivilegeAction.Read, 'Account', 'removedUnit')]), [])
        assert.equal(rows.length, 1)
        assert.ok(rows[0].scopeText.length > 0)
    })
})

describe('SecurityModelDraft.RecordSharingFor', () =>
{
    it('delegates to the deriver and stays read-only', () =>
    {
        const model: SecurityModelDto = {
            businessUnits: [],
            teams: [],
            membership: { claimsMapping: [], overrides: [] },
            ownershipRules: [Fixtures.Rule('Account')],
            roles: [Fixtures.Role([Fixtures.P(PrivilegeAction.Read, 'Account', AccessLevel.Organization)])]
        }
        const draft = SecurityModelDraft.From(model)
        const rows = draft.RecordSharingFor('r1')
        assert.equal(rows.length, 1)
        assert.match(rows[0].scopeText, /ownership rules/)
        assert.equal(draft.Dirty, false)
        assert.deepEqual(draft.RecordSharingFor('missing'), [])
    })
})
