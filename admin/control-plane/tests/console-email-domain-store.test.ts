import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConsoleEmailDomainStore, type IConsoleDomainVerifyChannel } from '../console-email-domain-store.js'
import { DomainApprovalState, DomainVerificationRecord, type DomainVerificationAnswer } from '../domain-verification-record.js'
import { InvalidEmailDomainError } from '../email-domain-policy.js'
import { DomainNotClaimedError, DomainVerificationUnavailableError, EmailDomainsNotEditableError } from '../tenant-api/tenant-email-domains.js'

class Names
{
    public static readonly TempPrefix = 'console-email-domains-'
    public static readonly TenantId = 'acme'
    public static readonly OtherTenantId = 'other'
    public static readonly SeedDomain = 'acme.test'
    public static readonly MessySeedDomain = 'Acme.TEST.'
    public static readonly NewDomain = 'acme-corp.test'
    public static readonly SecondDomain = 'second.test'
    public static readonly ThirdDomain = 'third.test'
    public static readonly UnlistedDomain = 'unlisted.test'
    public static readonly MalformedDomain = 'not a domain'
    public static readonly PublicMail = 'gmail.com'
    public static readonly Utf8 = 'utf8'
    public static readonly Token = 'A'.repeat(43)
    public static readonly OtherToken = 'B'.repeat(43)
    public static readonly CheckedAt = '2026-11-06T10:00:00.000Z'
    public static readonly NoChannelMessage = 'Domain verification is not available on this console.'
    public static readonly PlatformUnavailableMessage = 'The platform could not check the domain. Try again later.'
    public static readonly UnlistedMessage = 'unlisted.test is not among this console\'s email domains.'
}

/** A verify channel that records each domain it is asked about and answers what the test set (or throws). */
class FakeVerifyChannel implements IConsoleDomainVerifyChannel
{
    public readonly Asked: string[] = []
    public Answer: DomainVerificationAnswer | undefined
    public FailWith: Error | undefined

    public async VerifyDomain(domain: string): Promise<DomainVerificationAnswer>
    {
        this.Asked.push(domain)
        if (this.FailWith !== undefined)
        {
            throw this.FailWith
        }
        return this.Answer ?? FakeVerifyChannel.AnswerFor(domain, DomainApprovalState.Verified, true)
    }

    public static AnswerFor(domain: string, state: DomainApprovalState, verified: boolean, token: string = Names.Token): DomainVerificationAnswer
    {
        return { domain, token, verified, state, lastCheckedAt: Names.CheckedAt }
    }
}

describe('ConsoleEmailDomainStore', () =>
{
    let root = ''
    let file = ''

    beforeEach(() =>
    {
        root = mkdtempSync(join(tmpdir(), Names.TempPrefix))
        file = join(root, ConsoleEmailDomainStore.FileName)
    })

    afterEach(() =>
    {
        rmSync(root, { recursive: true, force: true })
    })

    it('opens with the seed domains when no file exists, without writing', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [' ACME.test. ', Names.PublicMail])
        assert.deepEqual(store.Domains, [Names.SeedDomain], 'normalised, the refused seed entry dropped')
        assert.deepEqual(await store.For(Names.TenantId), { domains: [Names.SeedDomain], editable: true, inHive: true, pending: [], verifications: [] })
        assert.equal(existsSync(file), false)
        assert.deepEqual(readdirSync(root), [])
    })

    it('opens empty when there is neither a file nor a seed', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, undefined)
        assert.deepEqual(store.Domains, [])
    })

    it('Set persists, survives reopen and wins over the seed', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        const view = await store.Set(Names.TenantId, [Names.NewDomain])
        assert.deepEqual(view, { domains: [Names.NewDomain], editable: true, inHive: true, pending: [], verifications: [] })
        assert.deepEqual(JSON.parse(readFileSync(file, Names.Utf8)), { domains: [Names.NewDomain] })
        const reopened = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        assert.deepEqual(reopened.Domains, [Names.NewDomain])
        assert.deepEqual(readdirSync(root), [ConsoleEmailDomainStore.FileName], 'no temp file is left behind')
    })

    it('Set to an empty list persists the empty list over the seed', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        await store.Set(Names.TenantId, [])
        const reopened = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        assert.deepEqual(reopened.Domains, [])
    })

    it('Set emits Changed once and not for an identical list', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        const seen: Array<readonly string[]> = []
        store.Changed.subscribe(d => seen.push(d))
        await store.Set(Names.TenantId, [Names.NewDomain])
        await store.Set(Names.TenantId, [Names.NewDomain.toUpperCase()])
        assert.deepEqual(seen, [[Names.NewDomain]])
    })

    it('two concurrent Sets: the last wins, the file is valid JSON, Changed per real change', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        const seen: Array<readonly string[]> = []
        store.Changed.subscribe(d => seen.push(d))
        await Promise.all([store.Set(Names.TenantId, [Names.NewDomain]), store.Set(Names.TenantId, [Names.SecondDomain])])
        assert.deepEqual(store.Domains, [Names.SecondDomain])
        assert.deepEqual(JSON.parse(readFileSync(file, Names.Utf8)), { domains: [Names.SecondDomain] })
        assert.deepEqual(seen, [[Names.NewDomain], [Names.SecondDomain]])
        assert.deepEqual(readdirSync(root), [ConsoleEmailDomainStore.FileName])
        await Promise.all([store.Set(Names.TenantId, [Names.SeedDomain]), store.Set(Names.TenantId, [Names.SeedDomain])])
        assert.equal(seen.length, 3, 'the second identical write is not a change')
    })

    it('Set refuses another tenant', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        await assert.rejects(() => store.Set(Names.OtherTenantId, [Names.NewDomain]), EmailDomainsNotEditableError)
        assert.deepEqual(await store.For(Names.OtherTenantId), { domains: [], editable: false, inHive: true, pending: [], verifications: [] })
        assert.deepEqual(store.Domains, [Names.SeedDomain])
        assert.equal(existsSync(file), false)
    })

    it('Set refuses a public mail domain and changes nothing', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        let changes = 0
        store.Changed.subscribe(() => changes++)
        await assert.rejects(() => store.Set(Names.TenantId, [Names.NewDomain, Names.PublicMail]), InvalidEmailDomainError)
        assert.deepEqual(store.Domains, [Names.SeedDomain])
        assert.equal(changes, 0)
        assert.equal(existsSync(file), false)
    })

    it('For shows adopted verifications with recordName and recordValue, and pending from their states', async () =>
    {
        const domains = [Names.SeedDomain, Names.NewDomain, Names.SecondDomain, Names.ThirdDomain, Names.UnlistedDomain]
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, domains)
        store.AdoptVerifications([
            FakeVerifyChannel.AnswerFor(Names.UnlistedDomain, DomainApprovalState.Revoked, false),
            FakeVerifyChannel.AnswerFor(Names.SecondDomain, DomainApprovalState.Pending, false, Names.OtherToken),
            FakeVerifyChannel.AnswerFor(Names.SeedDomain, DomainApprovalState.Verified, true),
            FakeVerifyChannel.AnswerFor(Names.NewDomain, DomainApprovalState.VerifiedContested, true),
        ])
        const view = await store.For(Names.TenantId)
        const listed = store.Domains.filter(d => d !== Names.ThirdDomain)
        assert.deepEqual(view.verifications.map(v => v.domain), listed, 'one view per adopted answer, in list order')
        for (const v of view.verifications)
        {
            assert.equal(v.recordName, DomainVerificationRecord.NamePrefix + v.domain)
            assert.equal(v.recordValue, DomainVerificationRecord.ValuePrefix + v.token)
        }
        assert.equal(view.verifications.find(v => v.domain === Names.SecondDomain)?.token, Names.OtherToken)
        assert.equal(view.verifications.find(v => v.domain === Names.SeedDomain)?.lastCheckedAt, Names.CheckedAt)
        assert.deepEqual(view.pending, [Names.NewDomain, Names.SecondDomain, Names.UnlistedDomain].sort(),
            'contested, pending and revoked answers are pending; verified is not, and a domain with no answer is unknown, not pending')
        assert.deepEqual(await store.For(Names.OtherTenantId), { domains: [], editable: false, inHive: true, pending: [], verifications: [] })
    })

    it('For without any adopted answer lists nothing as pending', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain, Names.NewDomain])
        assert.deepEqual((await store.For(Names.TenantId)).pending, [])
    })

    it('AdoptVerifications ignores answers for domains not in the list; a Set that drops a domain drops its answer', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain, Names.NewDomain])
        store.AdoptVerifications([
            FakeVerifyChannel.AnswerFor(Names.SeedDomain, DomainApprovalState.Pending, false),
            FakeVerifyChannel.AnswerFor(Names.NewDomain, DomainApprovalState.Pending, false),
            FakeVerifyChannel.AnswerFor(Names.SecondDomain, DomainApprovalState.Pending, false),
        ])
        assert.deepEqual((await store.For(Names.TenantId)).verifications.map(v => v.domain), [Names.NewDomain, Names.SeedDomain])
        const view = await store.Set(Names.TenantId, [Names.SeedDomain, Names.SecondDomain])
        assert.deepEqual(view.verifications.map(v => v.domain), [Names.SeedDomain], 'Set answers the surviving verifications')
        assert.deepEqual(view.pending, [Names.SeedDomain])
        assert.deepEqual((await store.For(Names.TenantId)).verifications.map(v => v.domain), [Names.SeedDomain],
            'the dropped domain\'s answer is gone, and the ignored one did not come back with the domain')
        store.AdoptVerifications([FakeVerifyChannel.AnswerFor(Names.SecondDomain, DomainApprovalState.Approved, false)])
        assert.deepEqual((await store.For(Names.TenantId)).verifications.map(v => v.domain), [Names.SecondDomain], 'an adoption replaces what was held')
        assert.deepEqual(JSON.parse(readFileSync(file, Names.Utf8)), { domains: [Names.SeedDomain, Names.SecondDomain] }, 'verifications are never written')
    })

    it('Verify forwards the normalised domain and merges the answer', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain, Names.NewDomain])
        store.AdoptVerifications([FakeVerifyChannel.AnswerFor(Names.NewDomain, DomainApprovalState.Pending, false)])
        const channel = new FakeVerifyChannel()
        channel.Answer = FakeVerifyChannel.AnswerFor(Names.SeedDomain, DomainApprovalState.VerifiedContested, true)
        store.AttachVerifyChannel(channel)
        const view = await store.Verify(Names.TenantId, Names.MessySeedDomain)
        assert.deepEqual(channel.Asked, [Names.SeedDomain])
        assert.deepEqual(view.verifications.map(v => [v.domain, v.state]), [[Names.NewDomain, DomainApprovalState.Pending], [Names.SeedDomain, DomainApprovalState.VerifiedContested]],
            'in list order')
        assert.deepEqual(view.pending, [Names.NewDomain, Names.SeedDomain])
        assert.deepEqual(await store.For(Names.TenantId), view, 'the merged answer is held')
        assert.equal(existsSync(file), false, 'Verify writes nothing')
    })

    it('Verify refuses another tenant and an unlisted domain without asking the channel', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        const channel = new FakeVerifyChannel()
        store.AttachVerifyChannel(channel)
        await assert.rejects(() => store.Verify(Names.OtherTenantId, Names.SeedDomain), EmailDomainsNotEditableError)
        await assert.rejects(() => store.Verify(Names.TenantId, Names.UnlistedDomain),
            (e: Error) => e instanceof DomainNotClaimedError && e.message === Names.UnlistedMessage)
        assert.deepEqual(channel.Asked, [])
    })

    it('Verify refuses a malformed domain with InvalidEmailDomainError before the list and channel checks', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        await assert.rejects(() => store.Verify(Names.TenantId, Names.MalformedDomain), InvalidEmailDomainError)
        const channel = new FakeVerifyChannel()
        store.AttachVerifyChannel(channel)
        await assert.rejects(() => store.Verify(Names.TenantId, Names.MalformedDomain), InvalidEmailDomainError)
        assert.deepEqual(channel.Asked, [])
    })

    it('Verify with no channel attached is DomainVerificationUnavailableError and writes nothing', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        await assert.rejects(() => store.Verify(Names.TenantId, Names.SeedDomain),
            (e: Error) => e instanceof DomainVerificationUnavailableError && e.message === Names.NoChannelMessage)
        assert.equal(existsSync(file), false)
    })

    it('Verify with a fake channel answers the merged view; a channel error passes through and changes nothing', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        const channel = new FakeVerifyChannel()
        store.AttachVerifyChannel(channel)
        const view = await store.Verify(Names.TenantId, Names.SeedDomain)
        assert.deepEqual(view.verifications, [DomainVerificationRecord.ViewOf(FakeVerifyChannel.AnswerFor(Names.SeedDomain, DomainApprovalState.Verified, true))])
        assert.deepEqual(view.pending, [])
        channel.FailWith = new DomainVerificationUnavailableError(Names.PlatformUnavailableMessage)
        await assert.rejects(() => store.Verify(Names.TenantId, Names.SeedDomain), channel.FailWith)
        assert.deepEqual(await store.For(Names.TenantId), view)
    })

    it('Verify refuses an answer for a different domain as unavailable and keeps nothing of it', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain, Names.NewDomain])
        const channel = new FakeVerifyChannel()
        channel.Answer = FakeVerifyChannel.AnswerFor(Names.NewDomain, DomainApprovalState.Verified, true)
        store.AttachVerifyChannel(channel)
        await assert.rejects(() => store.Verify(Names.TenantId, Names.SeedDomain),
            (e: Error) => e instanceof DomainVerificationUnavailableError && e.message === Names.PlatformUnavailableMessage)
        assert.deepEqual((await store.For(Names.TenantId)).verifications, [])
    })

    it('a file that is not { domains: string[] } fails the open naming the file', async () =>
    {
        writeFileSync(file, '{"domains": 3}')
        await assert.rejects(() => ConsoleEmailDomainStore.Open(file, Names.TenantId, undefined), new RegExp(ConsoleEmailDomainStore.FileName))
    })
})
