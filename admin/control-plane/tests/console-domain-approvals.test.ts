import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConsoleDomainApprovals, type DomainStanding } from '../console-domain-approvals.js'
import { DomainApprovalState, DomainVerificationRecord } from '../domain-verification-record.js'

/** Counts the file writes the store makes. */
class CountingApprovals extends ConsoleDomainApprovals
{
    public writes = 0

    protected override WriteText(text: string): Promise<void>
    {
        this.writes++
        return super.WriteText(text)
    }
}

class ApprovalsFixture
{
    public dir = ''
    public path = ''
    public approvals!: CountingApprovals

    public static async Run(body: (f: ApprovalsFixture) => Promise<void>): Promise<void>
    {
        const f = new ApprovalsFixture()
        f.dir = await mkdtemp(join(tmpdir(), 'domain-approvals-'))
        f.path = join(f.dir, ConsoleDomainApprovals.FileName)
        f.approvals = new CountingApprovals(f.path)
        try
        {
            await body(f)
        }
        finally
        {
            await rm(f.dir, { recursive: true, force: true })
        }
    }

    public async Reloaded(): Promise<ConsoleDomainApprovals>
    {
        const again = new ConsoleDomainApprovals(this.path)
        await again.Load()
        return again
    }
}

test('EnsureTokens issues one token per domain, normalised, and keeps it', async () =>
{
    await ApprovalsFixture.Run(async f =>
    {
        await f.approvals.EnsureTokens('acme', ['Acme.TEST.'])
        const token = f.approvals.VerificationOf('acme', 'acme.test')?.token as string
        assert.match(token, DomainVerificationRecord.TokenPattern)
        assert.equal(f.approvals.VerificationOf('acme', 'acme.test')?.verified, false)
        assert.equal(f.approvals.writes, 1)

        await f.approvals.EnsureTokens('acme', ['acme.test', ' ACME.test'])
        assert.equal(f.approvals.VerificationOf('acme', 'acme.test')?.token, token)
        assert.equal(f.approvals.writes, 1)

        await f.approvals.EnsureTokens('acme', ['acme.test', 'b.test', 'c.test'])
        assert.equal(f.approvals.writes, 2)
        assert.equal(f.approvals.VerificationOf('acme', 'acme.test')?.token, token)
        assert.notEqual(f.approvals.VerificationOf('acme', 'b.test')?.token, f.approvals.VerificationOf('acme', 'c.test')?.token)

        const again = await f.Reloaded()
        assert.equal(again.VerificationOf('acme', 'ACME.test')?.token, token)
        assert.deepEqual(again.ApprovedFor('acme'), [])
    })
})

test('EnsureTokens with no domains writes nothing and creates no record', async () =>
{
    await ApprovalsFixture.Run(async f =>
    {
        await f.approvals.EnsureTokens('acme', [])
        assert.equal(f.approvals.writes, 0)
        assert.equal(f.approvals.Get('acme'), undefined)
    })
})

test('RecordCheck stores verified and lastCheckedAt, and is a no-op without a token', async () =>
{
    await ApprovalsFixture.Run(async f =>
    {
        await f.approvals.RecordCheck('acme', 'acme.test', true, '2026-11-06T10:00:00.000Z')
        assert.equal(f.approvals.writes, 0)
        assert.equal(f.approvals.VerificationOf('acme', 'acme.test'), undefined)
        assert.equal(f.approvals.Get('acme'), undefined)

        await f.approvals.EnsureTokens('acme', ['acme.test'])
        const token = f.approvals.VerificationOf('acme', 'acme.test')?.token
        await f.approvals.RecordCheck('acme', 'Acme.Test.', true, '2026-11-06T10:00:00.000Z')
        assert.deepEqual(f.approvals.VerificationOf('acme', 'acme.test'), { token, verified: true, lastCheckedAt: '2026-11-06T10:00:00.000Z' })
        assert.deepEqual(f.approvals.StandingOf('acme').verified, ['acme.test'])

        await f.approvals.RecordCheck('acme', 'acme.test', false, '2026-11-07T10:00:00.000Z')
        const again = await f.Reloaded()
        assert.deepEqual(again.VerificationOf('acme', 'acme.test'), { token, verified: false, lastCheckedAt: '2026-11-07T10:00:00.000Z' })
        assert.deepEqual(again.StandingOf('acme').verified, [])
    })
})

test('Revoke stores a revoke even for a domain never approved, and Approve clears it', async () =>
{
    await ApprovalsFixture.Run(async f =>
    {
        await f.approvals.Revoke('acme', 'X.test.')
        assert.deepEqual(f.approvals.RevokedFor('acme'), ['x.test'])
        assert.deepEqual(f.approvals.ApprovedFor('acme'), [])
        const writes = f.approvals.writes
        await f.approvals.Revoke('acme', 'x.test')
        assert.equal(f.approvals.writes, writes)
        assert.deepEqual((await f.Reloaded()).RevokedFor('acme'), ['x.test'])

        await f.approvals.Approve('acme', 'x.test')
        assert.deepEqual(f.approvals.RevokedFor('acme'), [])
        assert.deepEqual(f.approvals.ApprovedFor('acme'), ['x.test'])
        const again = await f.Reloaded()
        assert.deepEqual(again.RevokedFor('acme'), [])
        assert.deepEqual(again.ApprovedFor('acme'), ['x.test'])
    })
})

test('ApproveAll writes only when it approves a domain or clears a revoke', async () =>
{
    await ApprovalsFixture.Run(async f =>
    {
        await f.approvals.Approve('acme', 'a.test')
        await f.approvals.Revoke('acme', 'b.test')
        const writes = f.approvals.writes
        await f.approvals.ApproveAll('acme', ['a.test', 'A.test.'])
        await f.approvals.ApproveAll('acme', [])
        assert.equal(f.approvals.writes, writes)
        assert.deepEqual(f.approvals.RevokedFor('acme'), ['b.test'])

        await f.approvals.ApproveAll('acme', ['B.test'])
        assert.deepEqual(f.approvals.ApprovedFor('acme'), ['a.test', 'b.test'])
        assert.deepEqual((await f.Reloaded()).RevokedFor('acme'), [])
    })
})

test('ApproveAll clears a revoke stored next to an approval of the same domain', async () =>
{
    await ApprovalsFixture.Run(async f =>
    {
        await writeFile(f.path, JSON.stringify({ approvals: { acme: { id: 'acme', tenantId: 'acme', domains: ['a.test'], revoked: ['a.test'] } } }))
        await f.approvals.Load()
        await f.approvals.ApproveAll('acme', ['a.test'])
        assert.equal(f.approvals.writes, 1)
        assert.deepEqual((await f.Reloaded()).StandingOf('acme'), { approved: ['a.test'], revoked: [], verified: [] })
    })
})

test('Revoke removes an approval and keeps the token', async () =>
{
    await ApprovalsFixture.Run(async f =>
    {
        await f.approvals.Approve('acme', 'acme.test')
        await f.approvals.EnsureTokens('acme', ['acme.test'])
        await f.approvals.RecordCheck('acme', 'acme.test', true, '2026-11-06T10:00:00.000Z')
        const token = f.approvals.VerificationOf('acme', 'acme.test')?.token
        await f.approvals.Revoke('acme', 'acme.test')
        const again = await f.Reloaded()
        assert.deepEqual(again.StandingOf('acme'), { approved: [], revoked: ['acme.test'], verified: ['acme.test'] })
        assert.equal(again.VerificationOf('acme', 'acme.test')?.token, token)
    })
})

test('a legacy record without revoked or verifications reads as empty', async () =>
{
    await ApprovalsFixture.Run(async f =>
    {
        await writeFile(f.path, JSON.stringify({ approvals: { acme: { id: 'acme', tenantId: 'acme', domains: ['a.test'] } } }))
        await f.approvals.Load()
        assert.deepEqual(f.approvals.StandingOf('acme'), { approved: ['a.test'], revoked: [], verified: [] })
        assert.deepEqual(f.approvals.RevokedFor('acme'), [])
        assert.equal(f.approvals.VerificationOf('acme', 'a.test'), undefined)
        assert.deepEqual(f.approvals.VerifiedEntries(), [])
        assert.deepEqual(f.approvals.StandingOf('nobody'), { approved: [], revoked: [], verified: [] })
    })
})

test('StandingOf normalises, dedupes and sorts a hand-edited record, so StateOf and EffectiveDomains agree', async () =>
{
    await ApprovalsFixture.Run(async f =>
    {
        const token = DomainVerificationRecord.NewToken()
        await f.approvals.Put({
            id: 'acme', tenantId: 'acme', domains: ['Z.test', ' a.test.', 'A.TEST'], revoked: ['R.Test.', 'b.test'],
            verifications: { 'V.Test.': { token, verified: true }, 'w.test': { token, verified: false } },
        })
        const standing = f.approvals.StandingOf('acme')
        assert.deepEqual(standing, { approved: ['a.test', 'z.test'], revoked: ['b.test', 'r.test'], verified: ['v.test'] })
        assert.equal(ConsoleDomainApprovals.StateOf(standing, 'r.test', false), DomainApprovalState.Revoked)
        assert.equal(ConsoleDomainApprovals.StateOf(standing, 'v.test', false), DomainApprovalState.Verified)
        assert.deepEqual(ConsoleDomainApprovals.EffectiveDomains(['a.test', 'r.test', 'v.test', 'z.test'], standing, new Set()), ['a.test', 'v.test', 'z.test'])
    })
})

test('only ForgetTenant removes a record: revoking every approval keeps the revokes', async () =>
{
    await ApprovalsFixture.Run(async f =>
    {
        await f.approvals.Approve('acme', 'a.test')
        await f.approvals.Revoke('acme', 'a.test')
        assert.equal(f.approvals.List().length, 1)
        assert.deepEqual(f.approvals.StandingOf('acme'), { approved: [], revoked: ['a.test'], verified: [] })

        await f.approvals.EnsureTokens('acme', ['a.test'])
        await f.approvals.ForgetTenant('acme')
        assert.equal(f.approvals.Get('acme'), undefined)
        assert.equal((await f.Reloaded()).List().length, 0)
    })
})

test('VerifiedEntries lists only verified entries, sorted by tenant then domain', async () =>
{
    await ApprovalsFixture.Run(async f =>
    {
        await f.approvals.EnsureTokens('zeta', ['z.test'])
        await f.approvals.EnsureTokens('acme', ['b.test', 'a.test', 'c.test'])
        await f.approvals.RecordCheck('zeta', 'z.test', true, '2026-11-06T10:00:00.000Z')
        await f.approvals.RecordCheck('acme', 'b.test', true, '2026-11-06T10:00:00.000Z')
        await f.approvals.RecordCheck('acme', 'a.test', true, '2026-11-06T10:00:00.000Z')
        await f.approvals.RecordCheck('acme', 'c.test', false, '2026-11-06T10:00:00.000Z')
        const entries = f.approvals.VerifiedEntries()
        assert.deepEqual(entries.map(e => [e.tenantId, e.domain]), [['acme', 'a.test'], ['acme', 'b.test'], ['zeta', 'z.test']])
        assert.equal(entries[0].token, f.approvals.VerificationOf('acme', 'a.test')?.token)
    })
})

test('StateOf follows the precedence table', () =>
{
    const standing: DomainStanding = { approved: ['a.test', 'all.test'], revoked: ['r.test', 'all.test'], verified: ['v.test', 'all.test'] }
    assert.equal(ConsoleDomainApprovals.StateOf(standing, 'r.test', false), DomainApprovalState.Revoked)
    assert.equal(ConsoleDomainApprovals.StateOf(standing, 'a.test', true), DomainApprovalState.Approved)
    assert.equal(ConsoleDomainApprovals.StateOf(standing, 'v.test', false), DomainApprovalState.Verified)
    assert.equal(ConsoleDomainApprovals.StateOf(standing, 'v.test', true), DomainApprovalState.VerifiedContested)
    assert.equal(ConsoleDomainApprovals.StateOf(standing, 'other.test', false), DomainApprovalState.Pending)
    assert.equal(ConsoleDomainApprovals.StateOf(standing, 'all.test', false), DomainApprovalState.Revoked)
    assert.equal(ConsoleDomainApprovals.StateOf(standing, ' V.Test.', false), DomainApprovalState.Verified)
})

test('EffectiveDomains: approved, or verified and uncontested, never revoked', () =>
{
    const claimed = ['a.test', 'b.test', 'c.test', 'd.test']
    const standing: DomainStanding = { approved: ['a.test'], revoked: ['d.test'], verified: ['b.test', 'c.test', 'd.test'] }
    assert.deepEqual(ConsoleDomainApprovals.EffectiveDomains(claimed, standing, new Set(['c.test'])), ['a.test', 'b.test'])
    assert.deepEqual(ConsoleDomainApprovals.EffectiveDomains(claimed, standing, new Set()), ['a.test', 'b.test', 'c.test'])
    assert.deepEqual(ConsoleDomainApprovals.EffectiveDomains(claimed, standing, new Set(['a.test'])), ['a.test', 'b.test', 'c.test'])
})

test('EffectiveDomains ignores an approved or verified domain that is not claimed', () =>
{
    const standing: DomainStanding = { approved: ['a.test'], revoked: [], verified: ['v.test'] }
    assert.deepEqual(ConsoleDomainApprovals.EffectiveDomains(['other.test'], standing, new Set()), [])
    assert.deepEqual(ConsoleDomainApprovals.EffectiveDomains([], standing, new Set()), [])
    assert.deepEqual(ConsoleDomainApprovals.EffectiveDomains([' V.test.', 'A.TEST', 'a.test'], standing, new Set()), ['a.test', 'v.test'])
})
