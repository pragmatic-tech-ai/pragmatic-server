import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DomainApprovalState, DomainVerificationRecord } from '../domain-verification-record.js'
import { InvalidEmailDomainError } from '../email-domain-policy.js'

const Token = 'A'.repeat(42) + '_'
const Mine = 'mine' + 'm'.repeat(39)
const Other = 'other' + 'o'.repeat(38)

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
    const chunks = ['pragmatic-domain-verification=' + Mine.slice(0, 20), Mine.slice(20)]
    assert.equal(DomainVerificationRecord.Matches([chunks], Mine), true)
})

test('Matches any of several records', () =>
{
    const spf = ['v=spf1 -all']
    const other = ['pragmatic-domain-verification=' + Other]
    const mine = ['pragmatic-domain-verification=' + Mine]
    assert.equal(DomainVerificationRecord.Matches([spf, other, mine], Mine), true)
    assert.equal(DomainVerificationRecord.Matches([spf, other], Mine), false)
})

test('Matches trims surrounding whitespace but is exact otherwise', () =>
{
    assert.equal(DomainVerificationRecord.Matches([[' pragmatic-domain-verification=' + Mine + ' ']], Mine), true)
    assert.equal(DomainVerificationRecord.Matches([['pragmatic-domain-verification=' + Mine.toUpperCase()]], Mine), false)
    assert.equal(DomainVerificationRecord.Matches([['pragmatic-domain-verification=' + Mine + '2']], Mine), false)
})

test('Matches reads no records as no match', () =>
{
    assert.equal(DomainVerificationRecord.Matches([], Mine), false)
})

test('Matches never matches a token outside TokenPattern, even against its own value', () =>
{
    assert.equal(DomainVerificationRecord.Matches([['pragmatic-domain-verification=']], ''), false)
    assert.equal(DomainVerificationRecord.Matches([['pragmatic-domain-verification=short']], 'short'), false)
    assert.equal(DomainVerificationRecord.Matches([['pragmatic-domain-verification=' + Mine + '=']], Mine + '='), false)
})

test('NameFor refuses a malformed domain with InvalidEmailDomainError', () =>
{
    for (const domain of ['', '.', 'acme..test', 'acme test', 'acme.test/x', '-acme.test'])
    {
        assert.throws(() => DomainVerificationRecord.NameFor(domain), InvalidEmailDomainError, JSON.stringify(domain))
    }
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
