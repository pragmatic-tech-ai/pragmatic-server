import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DomainApprovalState, DomainVerificationRecord } from '../domain-verification-record.js'

const Token = 'A'.repeat(42) + '_'

test('NameFor normalises case and one trailing dot', () =>
{
    assert.equal(DomainVerificationRecord.NameFor('Acme.TEST.'), '_pragmatic-verification.acme.test')
})

test('ValueFor prefixes the token', () =>
{
    assert.equal(DomainVerificationRecord.ValueFor('t'), 'pragmatic-domain-verification=t')
})

test('NewToken is 43 base64url chars and differs per call', () =>
{
    const first = DomainVerificationRecord.NewToken()
    const second = DomainVerificationRecord.NewToken()
    assert.match(first, DomainVerificationRecord.TokenPattern)
    assert.match(second, DomainVerificationRecord.TokenPattern)
    assert.notEqual(first, second)
})

test('Matches joins chunks of one record', () =>
{
    assert.equal(DomainVerificationRecord.Matches([['pragmatic-domain-verification=ab', 'cd']], 'abcd'), true)
})

test('Matches any of several records', () =>
{
    const spf = ['v=spf1 -all']
    const other = ['pragmatic-domain-verification=other']
    const mine = ['pragmatic-domain-verification=mine']
    assert.equal(DomainVerificationRecord.Matches([spf, other, mine], 'mine'), true)
    assert.equal(DomainVerificationRecord.Matches([spf, other], 'mine'), false)
})

test('Matches trims surrounding whitespace but is exact otherwise', () =>
{
    assert.equal(DomainVerificationRecord.Matches([[' pragmatic-domain-verification=mine ']], 'mine'), true)
    assert.equal(DomainVerificationRecord.Matches([['pragmatic-domain-verification=MINE']], 'mine'), false)
    assert.equal(DomainVerificationRecord.Matches([['pragmatic-domain-verification=mine2']], 'mine'), false)
})

test('Matches reads no records as no match', () =>
{
    assert.equal(DomainVerificationRecord.Matches([], 'mine'), false)
})

test('ViewOf adds the record name and value', () =>
{
    const answer = { domain: 'acme.test', token: Token, verified: false, state: DomainApprovalState.Pending }
    assert.deepEqual(DomainVerificationRecord.ViewOf(answer), {
        ...answer,
        recordName: '_pragmatic-verification.acme.test',
        recordValue: 'pragmatic-domain-verification=' + Token,
    })
})

test('ParseAnswer accepts a well-formed answer and drops anything else', () =>
{
    const good = {
        domain: 'acme.test',
        token: Token,
        verified: true,
        state: DomainApprovalState.VerifiedContested,
        lastCheckedAt: '2026-11-06T10:00:00.000Z',
    }
    assert.deepEqual(DomainVerificationRecord.ParseAnswer(good), good)
    const { lastCheckedAt: _omitted, ...withoutCheck } = good
    assert.deepEqual(DomainVerificationRecord.ParseAnswer(withoutCheck), withoutCheck)
    assert.deepEqual(DomainVerificationRecord.ParseAnswer({ ...good, extra: 'x' }), good)

    const refused: unknown[] = [
        { ...good, token: 'short' },
        { ...good, token: Token + '=' },
        { ...good, state: 'approved-ish' },
        { ...good, verified: 'true' },
        { ...good, lastCheckedAt: 'not a time' },
        { ...good, lastCheckedAt: 12 },
        { ...good, domain: 'acme..test' },
        { ...good, domain: 7 },
        [good],
        null,
        'acme.test',
    ]
    for (const value of refused)
    {
        assert.equal(DomainVerificationRecord.ParseAnswer(value), undefined, JSON.stringify(value))
    }
})
