import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EmailDomainPolicy, InvalidEmailDomainError } from '../email-domain-policy.js'

test('Normalise trims, lower-cases and drops a trailing dot', () =>
{
    assert.equal(EmailDomainPolicy.Normalise(' Acme.TEST. '), 'acme.test')
})

test('accepts ordinary company domains', () =>
{
    for (const d of ['acme.com', 'eu.acme.co.uk', 'xn--bcher-kva.example'])
    {
        assert.equal(EmailDomainPolicy.Check(d), undefined, d)
    }
})

test('refuses malformed names', () =>
{
    for (const d of ['acme', 'acme..com', '-acme.com', 'acme-.com', '*.acme.com', 'acme.com/x', '10.0.0.1', 'a'.repeat(64) + '.com'])
    {
        const sentence = EmailDomainPolicy.Check(d)
        assert.ok(sentence !== undefined && sentence.endsWith('is not a valid domain name.'), d)
    }
})

test('a public domain suffix gets its own sentence', () =>
{
    for (const d of ['co.uk', 'com.au'])
    {
        assert.equal(EmailDomainPolicy.Check(d), `${d} is a public domain suffix shared by many organisations, so it cannot point to one tenant.`)
    }
    assert.equal(EmailDomainPolicy.Check('acme.co.uk'), undefined)
})

test('a non-ASCII domain is told to use its xn-- form', () =>
{
    // 'b', U+00FC (u with diaeresis), 'cher.example': built from its code point so this file stays ASCII.
    const domain = 'b' + String.fromCodePoint(0xfc) + 'cher.example'
    const sentence = EmailDomainPolicy.Check(domain)
    assert.equal(sentence, domain + ' is not an ASCII domain name: enter its internationalised form, which starts with xn--.')
})

test('refuses public mail domains', () =>
{
    for (const d of ['gmail.com', 'Outlook.com', 'hotmail.co.uk', 'yahoo.fr', 'proton.me'])
    {
        const sentence = EmailDomainPolicy.Check(EmailDomainPolicy.Normalise(d))
        assert.ok(sentence !== undefined && sentence.includes('is a public mail domain: anyone can have an address there'), d)
    }
    assert.equal(EmailDomainPolicy.Check('outlook.acme.com'), undefined)
})

test('Parse dedupes and sorts', () =>
{
    assert.deepEqual(EmailDomainPolicy.Parse(['b.test', 'A.test', 'a.test']), ['a.test', 'b.test'])
})

test('Parse refuses more than 20 domains', () =>
{
    const many = Array.from({ length: 21 }, (_, i) => `d${i}.test`)
    assert.throws(() => EmailDomainPolicy.Parse(many), (e: unknown) => e instanceof InvalidEmailDomainError && e.message === 'List at most 20 email domains.')
    assert.equal(EmailDomainPolicy.Parse(many.slice(0, 20)).length, 20)
})

test('Parse names the first bad domain', () =>
{
    assert.throws(() => EmailDomainPolicy.Parse(['acme.test', 'gmail.com']),
        (e: unknown) => e instanceof InvalidEmailDomainError && e.message.includes('gmail.com') && e.message.includes('public mail domain'))
})

test('Parse refuses a non-list', () =>
{
    for (const v of ['acme.test', [1], undefined, null, {}])
    {
        assert.throws(() => EmailDomainPolicy.Parse(v), (e: unknown) => e instanceof InvalidEmailDomainError && e.message === 'Email domains must be a list of domain names.')
    }
})

test('Filter splits accepted from refused', () =>
{
    assert.deepEqual(EmailDomainPolicy.Filter(['acme.test', 'gmail.com', 'bad..x', 'ACME.test']), { accepted: ['acme.test'], refused: ['gmail.com', 'bad..x'] })
})

test('DomainOf takes the part after the last @', () =>
{
    assert.equal(EmailDomainPolicy.DomainOf(' Ann@Acme.Test '), 'acme.test')
    assert.equal(EmailDomainPolicy.DomainOf('a@b@c.test'), 'c.test')
    assert.equal(EmailDomainPolicy.DomainOf('no-at'), undefined)
    assert.equal(EmailDomainPolicy.DomainOf('a@'), undefined)
})
