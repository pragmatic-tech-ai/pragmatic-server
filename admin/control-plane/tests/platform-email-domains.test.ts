import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ClientRegistry } from '../client-registry.js'
import { ConsoleAdvertRegistry } from '../console-advert-registry.js'
import { ConsoleDomainApprovals } from '../console-domain-approvals.js'
import { DomainApprovalState, DomainVerificationRecord, type DomainVerificationView } from '../domain-verification-record.js'
import { InvalidEmailDomainError } from '../email-domain-policy.js'
import { HiveRegistry } from '../hive-registry.js'
import { IngressTlsSource } from '../ingress-tls.js'
import { PlatformDirectory, UnknownTenantError } from '../platform-directory.js'
import { EmailDomainApprovalRefusedError, EmailDomainSource, PlatformEmailDomains, type EmailDomainApproval } from '../platform-email-domains.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import { TenantRegistry } from '../tenant-registry.js'
import {
    DomainNotClaimedError, DomainVerificationUnavailableError, DomainVerifyThrottledError, EmailDomainsNotEditableError, type TenantEmailDomainsView,
} from '../tenant-api/tenant-email-domains.js'
import { DomainTxtVerifier, TxtLookupStatus, type ITxtResolver, type TxtLookup } from '../txt-resolver.js'

/** Answers every lookup with `answer` (or what `ours` builds from the stored token) and records each queried name. */
class FakeTxtResolver implements ITxtResolver
{
    public readonly Names: string[] = []
    public answer: TxtLookup = { status: TxtLookupStatus.NoRecord, records: [] }

    public async ResolveTxt(name: string): Promise<TxtLookup>
    {
        this.Names.push(name)
        return { status: this.answer.status, records: this.answer.records.map(r => [...r]) }
    }
}

/** A row or view entry with its token-dependent fields checked by shape and dropped, so the rest compares exactly. */
class Shape
{
    private static readonly RecordValuePattern = new RegExp('^' + DomainVerificationRecord.ValuePrefix + DomainVerificationRecord.TokenPattern.source.slice(1))

    public static Row(row: EmailDomainApproval): Omit<EmailDomainApproval, 'recordValue'>
    {
        const { recordValue, ...rest } = row
        assert.equal(recordValue === undefined, row.recordName === undefined, 'recordName and recordValue come together')
        if (recordValue !== undefined)
        {
            assert.match(recordValue, Shape.RecordValuePattern)
        }
        return rest
    }

    public static Rows(rows: readonly EmailDomainApproval[] | undefined): Array<Omit<EmailDomainApproval, 'recordValue'>>
    {
        return (rows ?? []).map(r => Shape.Row(r))
    }

    public static Verification(entry: DomainVerificationView): Omit<DomainVerificationView, 'token' | 'recordValue'>
    {
        const { token, recordValue, ...rest } = entry
        assert.ok(DomainVerificationRecord.IsToken(token))
        assert.equal(recordValue, DomainVerificationRecord.ValueFor(token))
        return rest
    }

    public static View(view: TenantEmailDomainsView): Omit<TenantEmailDomainsView, 'verifications'> & { verifications: Array<Omit<DomainVerificationView, 'token' | 'recordValue'>> }
    {
        return { ...view, verifications: view.verifications.map(v => Shape.Verification(v)) }
    }

    /** The expected row for a domain with a token. */
    public static Expected(domain: string, approved: boolean, state: DomainApprovalState, sharedWith: string[] = [], claimed = true): Omit<EmailDomainApproval, 'recordValue'>
    {
        return { domain, approved, claimed, sharedWith, state, verified: false, recordName: DomainVerificationRecord.NamePrefix + domain }
    }

    /** The expected view entry for a domain, unverified and never checked. */
    public static Entry(domain: string, state: DomainApprovalState): Omit<DomainVerificationView, 'token' | 'recordValue'>
    {
        return { domain, verified: false, state, recordName: DomainVerificationRecord.NamePrefix + domain }
    }
}

class DomainsFixture
{
    public static readonly ReportedAt = '2026-11-04T10:00:00.000Z'
    public static readonly Spec = { cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } }
    public static readonly Start = Date.parse('2026-11-06T09:00:00.000Z')

    public dir = ''
    public directory!: PlatformDirectory
    public adverts!: ConsoleAdvertRegistry
    public approvals!: ConsoleDomainApprovals
    public domains!: PlatformEmailDomains
    public readonly resolver = new FakeTxtResolver()
    public clock = DomainsFixture.Start

    public async Open(): Promise<void>
    {
        this.dir = mkdtempSync(join(tmpdir(), 'platform-email-domains-'))
        this.directory = new PlatformDirectory(
            new ClientRegistry(join(this.dir, 'clients.json')),
            new TenantRegistry(join(this.dir, 'tenants.json')),
            new HiveRegistry(join(this.dir, 'hives.json')),
            { List: () => [] })
        await this.directory.Load()
        this.adverts = new ConsoleAdvertRegistry(join(this.dir, ConsoleAdvertRegistry.FileName))
        await this.adverts.Load()
        this.approvals = new ConsoleDomainApprovals(join(this.dir, ConsoleDomainApprovals.FileName))
        await this.approvals.Load()
        this.domains = new PlatformEmailDomains(this.directory, this.adverts, this.approvals, new DomainTxtVerifier(this.resolver), undefined, () => new Date(this.clock))
        await this.directory.CreateClient({ id: 'c1', displayName: 'C1' })
        await this.directory.CreateTenant({ id: 'beta', clientId: 'c1', displayName: 'Beta' })
        await this.directory.CreateTenant({ id: 'acme', clientId: 'c1', displayName: 'Acme' })
        await this.directory.CreateHive({ id: 'acme-hive', tenantId: 'acme', displayName: 'Acme hive', ...DomainsFixture.Spec })
        await this.directory.SetHiveConsole('acme-hive', { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development } })
    }

    public async Advertise(emailDomains: string[]): Promise<void>
    {
        await this.adverts.Report({
            tenantId: 'acme', hiveId: 'acme-hive', consoleUrl: 'https://console-acme.localtest.me', fingerprints: [], emailDomains,
            reportedAt: DomainsFixture.ReportedAt,
        })
    }

    /** Makes the resolver answer the domain's stored token record, next to an SPF record (issuing the token first). */
    public async PublishOurs(tenantId: string, domain: string): Promise<void>
    {
        await this.approvals.EnsureTokens(tenantId, [domain])
        const token = this.approvals.VerificationOf(tenantId, domain)?.token ?? ''
        this.resolver.answer = { status: TxtLookupStatus.Found, records: [['v=spf1 -all'], [DomainVerificationRecord.ValueFor(token)]] }
    }

    public At(minutes: number): string
    {
        this.clock = DomainsFixture.Start + minutes * 60 * 1000
        return new Date(this.clock).toISOString()
    }

    public Close(): void
    {
        rmSync(this.dir, { recursive: true, force: true })
    }
}

describe('PlatformEmailDomains', () =>
{
    let f: DomainsFixture

    beforeEach(async () =>
    {
        f = new DomainsFixture()
        await f.Open()
    })

    afterEach(() =>
    {
        f.Close()
    })

    it('a control-plane tenant reports its record domains as editable, each with its approval', async () =>
    {
        await f.directory.SetTenantEmailDomains('beta', ['beta.test'])
        assert.equal(f.domains.IsInHive('beta'), false)
        const report = await f.domains.Report('beta')
        assert.deepEqual({ ...report, approvals: Shape.Rows(report?.approvals) }, {
            tenantId: 'beta', domains: ['beta.test'], source: EmailDomainSource.Tenant, editable: true, sharedWith: [],
            approvals: [Shape.Expected('beta.test', false, DomainApprovalState.Pending)],
        })
        assert.deepEqual(Shape.View(await f.domains.For('beta')), {
            domains: ['beta.test'], editable: true, inHive: false, pending: ['beta.test'], verifications: [Shape.Entry('beta.test', DomainApprovalState.Pending)],
        })
    })

    it('an in-hive tenant reports its advert domains read-only with the report time', async () =>
    {
        await f.Advertise(['acme.test'])
        assert.equal(f.domains.IsInHive('acme'), true)
        const report = await f.domains.Report('acme')
        assert.deepEqual({ ...report, approvals: Shape.Rows(report?.approvals) }, {
            tenantId: 'acme', domains: ['acme.test'], source: EmailDomainSource.Console, editable: false, reportedAt: DomainsFixture.ReportedAt, sharedWith: [],
            approvals: [Shape.Expected('acme.test', false, DomainApprovalState.Pending)],
        })
        assert.deepEqual(Shape.View(await f.domains.For('acme')), {
            domains: ['acme.test'], editable: false, inHive: true, pending: ['acme.test'], verifications: [Shape.Entry('acme.test', DomainApprovalState.Pending)],
        })
    })

    it('an in-hive tenant without an advert reports none', async () =>
    {
        assert.deepEqual(await f.domains.Report('acme'), { tenantId: 'acme', domains: [], source: EmailDomainSource.Console, editable: false, sharedWith: [], approvals: [] })
    })

    it('an in-hive tenant ignores the domains left in its record', async () =>
    {
        await f.directory.SetTenantEmailDomains('acme', ['old.test'])
        await f.Advertise(['acme.test'])
        assert.deepEqual((await f.domains.Report('acme'))?.domains, ['acme.test'])
    })

    it('Set refuses an in-hive tenant with the plain sentence', async () =>
    {
        await assert.rejects(f.domains.Set('acme', ['acme.test']),
            (e: Error) => e instanceof EmailDomainsNotEditableError && e.message === "This tenant's console runs in its hive; its email domains are set there by the tenant Owner.")
        await assert.rejects(f.domains.SetAsOperator('acme', ['acme.test']), EmailDomainsNotEditableError)
        assert.equal(f.directory.GetTenant('acme')?.emailDomains, undefined)
        assert.deepEqual(f.approvals.ApprovedFor('acme'), [])
    })

    it('Set (the tenant Owner) stores a control-plane tenant\'s domains normalised and leaves them pending', async () =>
    {
        assert.deepEqual(Shape.View(await f.domains.Set('beta', ['Beta.TEST', 'beta.test'])), {
            domains: ['beta.test'], editable: true, inHive: false, pending: ['beta.test'], verifications: [Shape.Entry('beta.test', DomainApprovalState.Pending)],
        })
        assert.deepEqual(f.directory.GetTenant('beta')?.emailDomains, ['beta.test'])
        assert.deepEqual(f.approvals.ApprovedFor('beta'), [])
        await assert.rejects(f.domains.Set('beta', ['gmail.com']), InvalidEmailDomainError)
    })

    it('an Owner-set domain takes effect once an operator approves it', async () =>
    {
        await f.domains.Set('beta', ['beta.test', 'victim.test'])
        assert.equal(await f.domains.Approve('beta', ' Beta.TEST '), 'beta.test')
        assert.deepEqual(f.approvals.ApprovedFor('beta'), ['beta.test'])
        assert.deepEqual((await f.domains.For('beta')).pending, ['victim.test'])
        assert.deepEqual(Shape.Rows((await f.domains.Report('beta'))?.approvals), [
            Shape.Expected('beta.test', true, DomainApprovalState.Approved),
            Shape.Expected('victim.test', false, DomainApprovalState.Pending),
        ])
    })

    it('SetAsOperator stores the domains and approves each one it saved', async () =>
    {
        await f.domains.Set('beta', ['owner.test'])
        await f.domains.SetAsOperator('beta', ['Beta.TEST', 'eu.beta.test'])
        assert.deepEqual(f.directory.GetTenant('beta')?.emailDomains, ['beta.test', 'eu.beta.test'])
        assert.deepEqual(f.approvals.ApprovedFor('beta'), ['beta.test', 'eu.beta.test'])
        assert.deepEqual((await f.domains.For('beta')).pending, [])
        await assert.rejects(f.domains.SetAsOperator('beta', ['gmail.com']), InvalidEmailDomainError)
        assert.deepEqual(f.approvals.ApprovedFor('beta'), ['beta.test', 'eu.beta.test'])
        await assert.rejects(f.domains.SetAsOperator('nope', ['nope.test']), UnknownTenantError)
    })

    it('SetAsOperator approves only the domains its write adds; the Owner\'s pending domains stay pending', async () =>
    {
        await f.domains.Set('beta', ['victim.test'])
        assert.deepEqual(await f.domains.SetAsOperator('beta', ['victim.test', 'Beta.TEST']), ['beta.test'])
        assert.deepEqual(f.directory.GetTenant('beta')?.emailDomains, ['beta.test', 'victim.test'])
        assert.deepEqual(f.approvals.ApprovedFor('beta'), ['beta.test'])
        assert.deepEqual((await f.domains.For('beta')).pending, ['victim.test'])
        assert.deepEqual(await f.domains.SetAsOperator('beta', ['victim.test', 'beta.test']), [])
        assert.deepEqual(f.approvals.ApprovedFor('beta'), ['beta.test'])
    })

    it('an unknown tenant reads as none and cannot be set', async () =>
    {
        assert.equal(await f.domains.Report('nope'), undefined)
        assert.deepEqual(await f.domains.For('nope'), { domains: [], editable: false, inHive: false, pending: [], verifications: [] })
        await assert.rejects(f.domains.Set('nope', []), UnknownTenantError)
    })

    it('sharedWith names other tenants claiming the same domain', async () =>
    {
        await f.directory.SetTenantEmailDomains('beta', ['shared.test', 'beta.test'])
        await f.Advertise(['shared.test', 'acme.test'])
        assert.deepEqual((await f.domains.Report('beta'))?.sharedWith, ['acme'])
        const acme = await f.domains.Report('acme')
        assert.deepEqual(acme?.sharedWith, ['beta'])
        assert.deepEqual(Shape.Rows(acme?.approvals), [
            Shape.Expected('acme.test', false, DomainApprovalState.Pending),
            Shape.Expected('shared.test', false, DomainApprovalState.Pending, ['beta']),
        ])
    })

    it('Approve marks an advertised domain approved and Revoke withdraws it', async () =>
    {
        await f.Advertise(['acme.test'])
        await f.domains.Approve('acme', ' Acme.TEST ')
        assert.deepEqual(f.approvals.ApprovedFor('acme'), ['acme.test'])
        assert.deepEqual(Shape.Rows((await f.domains.Report('acme'))?.approvals), [Shape.Expected('acme.test', true, DomainApprovalState.Approved)])
        assert.deepEqual((await f.domains.For('acme')).pending, [])
        assert.equal(await f.domains.Revoke('acme', 'Acme.test.'), 'acme.test')
        assert.deepEqual(f.approvals.ApprovedFor('acme'), [])
    })

    it('Revoke of a never-approved domain stores a revoke and leaves approvals unchanged', async () =>
    {
        await f.Advertise(['acme.test', 'two.test'])
        await f.domains.Approve('acme', 'acme.test')
        await f.domains.Revoke('acme', 'two.test')
        await f.domains.Revoke('beta', 'beta.test')
        assert.deepEqual(f.approvals.ApprovedFor('acme'), ['acme.test'])
        assert.deepEqual(f.approvals.ApprovedFor('beta'), [])
        assert.deepEqual(f.approvals.RevokedFor('acme'), ['two.test'])
        assert.deepEqual(f.approvals.RevokedFor('beta'), ['beta.test'])
    })

    it('Revoke clears a stored approval the policy now refuses', async () =>
    {
        await f.approvals.Put({ id: 'acme', tenantId: 'acme', domains: ['acme.test', 'gmail.com'] })
        await f.domains.Revoke('acme', 'Gmail.COM')
        assert.deepEqual(f.approvals.ApprovedFor('acme'), ['acme.test'])
    })

    it('Revoke refuses what is not a domain name, so no unbounded text reaches the audit note', async () =>
    {
        await f.domains.Approve('acme', 'acme.test').catch(() => undefined)
        for (const bad of ['not a domain', 'x'.repeat(16000), 'a'.repeat(250) + '.test', 'acme', 'b' + String.fromCodePoint(0xfc) + 'cher.example'])
        {
            await assert.rejects(f.domains.Revoke('acme', bad), InvalidEmailDomainError)
        }
    })

    it('Approve refuses a domain the console does not advertise', async () =>
    {
        await f.Advertise(['acme.test'])
        await assert.rejects(f.domains.Approve('acme', 'other.test'),
            (e: Error) => e instanceof EmailDomainApprovalRefusedError && e.message === "other.test is not among the email domains this tenant's console reports, so there is nothing to approve.")
        assert.deepEqual(f.approvals.ApprovedFor('acme'), [])
    })

    it('Approve refuses a domain a control-plane record does not hold, a public mail domain and an unknown tenant', async () =>
    {
        await f.directory.SetTenantEmailDomains('beta', ['beta.test'])
        await assert.rejects(f.domains.Approve('beta', 'other.test'),
            (e: Error) => e instanceof EmailDomainApprovalRefusedError && e.message === "other.test is not among this tenant's email domains, so there is nothing to approve.")
        await assert.rejects(f.domains.Approve('acme', 'gmail.com'), InvalidEmailDomainError)
        await assert.rejects(f.domains.Approve('nope', 'acme.test'), UnknownTenantError)
        await assert.rejects(f.domains.Revoke('nope', 'acme.test'), UnknownTenantError)
    })

    it('an approval survives a re-advert, and a dropped approved domain is listed as no longer claimed so it can be revoked', async () =>
    {
        await f.Advertise(['acme.test', 'two.test'])
        await f.domains.Approve('acme', 'two.test')
        await f.Advertise(['acme.test'])
        assert.deepEqual(Shape.Rows((await f.domains.Report('acme'))?.approvals), [
            Shape.Expected('acme.test', false, DomainApprovalState.Pending),
            { domain: 'two.test', approved: true, claimed: false, sharedWith: [], state: DomainApprovalState.Approved, verified: false },
        ])
        assert.deepEqual((await f.domains.For('acme')).pending, ['acme.test'])
        await f.Advertise(['acme.test', 'two.test'])
        assert.deepEqual(Shape.Row((await f.domains.Report('acme'))?.approvals?.find(a => a.domain === 'two.test') as EmailDomainApproval),
            Shape.Expected('two.test', true, DomainApprovalState.Approved))
        await f.Advertise(['acme.test'])
        await f.domains.Revoke('acme', 'two.test')
        assert.deepEqual((await f.domains.Report('acme'))?.approvals?.map(a => a.domain), ['acme.test'])
    })

    it('an operator-approved domain removed from a control-plane record is listed as no longer claimed', async () =>
    {
        await f.domains.SetAsOperator('beta', ['beta.test', 'old.test'])
        await f.domains.SetAsOperator('beta', ['beta.test'])
        assert.deepEqual(Shape.Rows((await f.domains.Report('beta'))?.approvals), [
            Shape.Expected('beta.test', true, DomainApprovalState.Approved),
            { domain: 'old.test', approved: true, claimed: false, sharedWith: [], state: DomainApprovalState.Approved, verified: false },
        ])
    })

    it('after the console is removed the record domains count again', async () =>
    {
        await f.directory.SetTenantEmailDomains('acme', ['old.test'])
        await f.Advertise(['acme.test'])
        await f.directory.SetHiveConsole('acme-hive', undefined)
        const report = await f.domains.Report('acme')
        assert.deepEqual({ ...report, approvals: Shape.Rows(report?.approvals) }, {
            tenantId: 'acme', domains: ['old.test'], source: EmailDomainSource.Tenant, editable: true, sharedWith: [],
            approvals: [Shape.Expected('old.test', false, DomainApprovalState.Pending)],
        })
    })

    it('without an approval store Approve is refused and every domain stays pending', async () =>
    {
        await f.Advertise(['acme.test'])
        const bare = new PlatformEmailDomains(f.directory, f.adverts)
        await assert.rejects(bare.Approve('acme', 'acme.test'), EmailDomainApprovalRefusedError)
        assert.deepEqual((await bare.Report('acme'))?.approvals, [{ domain: 'acme.test', approved: false, claimed: true, sharedWith: [], state: DomainApprovalState.Pending, verified: false }])
        await bare.SetAsOperator('beta', ['beta.test'])
        assert.deepEqual(await bare.For('beta'), { domains: ['beta.test'], editable: true, inHive: false, pending: ['beta.test'], verifications: [] })
        await assert.rejects(bare.VerifyDomain('beta', 'beta.test'),
            (e: Error) => e instanceof DomainVerificationUnavailableError && e.message === 'DNS verification is not available on this control plane.')
        assert.deepEqual(await bare.AnswersFor('beta', ['beta.test']), [])
    })

    it('Report issues tokens and shows the record for each claimed domain', async () =>
    {
        await f.domains.Set('beta', ['beta.test', 'eu.beta.test'])
        const rows = (await f.domains.Report('beta'))?.approvals ?? []
        assert.deepEqual(rows.map(r => r.recordName), ['_pragmatic-verification.beta.test', '_pragmatic-verification.eu.beta.test'])
        for (const row of rows)
        {
            assert.ok(row.recordValue?.startsWith('pragmatic-domain-verification='))
            assert.equal(row.recordValue, DomainVerificationRecord.ValueFor(f.approvals.VerificationOf('beta', row.domain)?.token ?? ''))
            assert.equal(row.verified, false)
            assert.equal(row.state, DomainApprovalState.Pending)
            assert.equal(row.lastCheckedAt, undefined)
        }
        const again = (await f.domains.Report('beta'))?.approvals ?? []
        assert.deepEqual(again.map(r => r.recordValue), rows.map(r => r.recordValue), 'a second report keeps the issued tokens')
    })

    it('VerifyDomain with a matching record verifies, and the row reads Verified', async () =>
    {
        await f.domains.Set('beta', ['beta.test', 'other.test'])
        await f.PublishOurs('beta', 'beta.test')
        const checkedAt = f.At(1)
        const answer = await f.domains.VerifyDomain('beta', 'beta.test')
        assert.deepEqual(answer, { domain: 'beta.test', token: f.approvals.VerificationOf('beta', 'beta.test')?.token, verified: true, state: DomainApprovalState.Verified, lastCheckedAt: checkedAt })
        const row = (await f.domains.Report('beta'))?.approvals?.find(a => a.domain === 'beta.test') as EmailDomainApproval
        assert.deepEqual(Shape.Row(row), { ...Shape.Expected('beta.test', false, DomainApprovalState.Verified), verified: true, lastCheckedAt: checkedAt })
        const view = await f.domains.For('beta')
        assert.deepEqual(view.pending, ['other.test'])
        assert.deepEqual(view.verifications.map(v => [v.domain, v.state, v.verified]), [['beta.test', DomainApprovalState.Verified, true], ['other.test', DomainApprovalState.Pending, false]])
        const verified = await f.domains.Verify('beta', 'beta.test')
        assert.deepEqual(verified, await f.domains.For('beta'), 'Verify answers the tenant view')
    })

    it('VerifyDomain normalises Acme.TEST. and queries the lowercase name', async () =>
    {
        await f.Advertise(['acme.test'])
        await f.PublishOurs('acme', 'acme.test')
        const answer = await f.domains.VerifyDomain('acme', 'Acme.TEST.')
        assert.deepEqual(f.resolver.Names, ['_pragmatic-verification.acme.test'])
        assert.equal(answer.domain, 'acme.test')
        assert.equal(answer.state, DomainApprovalState.Verified)
        assert.equal(f.approvals.VerificationOf('acme', 'acme.test')?.verified, true)
    })

    it('a verified domain another tenant claims reads VerifiedContested and stays pending; once the other tenant drops it, it reads Verified', async () =>
    {
        await f.domains.Set('beta', ['shared.test'])
        await f.Advertise(['shared.test', 'acme.test'])
        await f.PublishOurs('beta', 'shared.test')
        assert.equal((await f.domains.VerifyDomain('beta', 'shared.test')).state, DomainApprovalState.VerifiedContested)
        assert.deepEqual((await f.domains.Report('beta'))?.approvals?.map(a => [a.state, a.sharedWith]), [[DomainApprovalState.VerifiedContested, ['acme']]])
        assert.deepEqual((await f.domains.For('beta')).pending, ['shared.test'])
        await f.Advertise(['acme.test'])
        assert.deepEqual((await f.domains.Report('beta'))?.approvals?.map(a => [a.state, a.sharedWith]), [[DomainApprovalState.Verified, []]])
        assert.deepEqual((await f.domains.For('beta')).pending, [])
        await f.Advertise(['shared.test', 'acme.test'])
        assert.deepEqual((await f.domains.For('beta')).pending, ['shared.test'], 'contested again, it leaves effect again')
    })

    it('a revoke keeps a verified domain Revoked until an operator approves it', async () =>
    {
        await f.domains.Set('beta', ['beta.test'])
        await f.PublishOurs('beta', 'beta.test')
        await f.domains.VerifyDomain('beta', 'beta.test')
        await f.domains.Revoke('beta', 'beta.test')
        assert.deepEqual((await f.domains.Report('beta'))?.approvals?.map(a => [a.state, a.verified]), [[DomainApprovalState.Revoked, true]])
        assert.deepEqual((await f.domains.For('beta')).pending, ['beta.test'])
        assert.equal((await f.domains.VerifyDomain('beta', 'beta.test')).state, DomainApprovalState.Revoked, 'verifying again does not lift the revoke')
        await f.domains.Approve('beta', 'beta.test')
        assert.deepEqual((await f.domains.Report('beta'))?.approvals?.map(a => [a.state, a.approved]), [[DomainApprovalState.Approved, true]])
        assert.deepEqual((await f.domains.For('beta')).pending, [])
    })

    it('a missing record records Not verified with lastCheckedAt, a changed record too', async () =>
    {
        await f.domains.Set('beta', ['beta.test'])
        await f.PublishOurs('beta', 'beta.test')
        await f.domains.VerifyDomain('beta', 'beta.test')
        f.resolver.answer = { status: TxtLookupStatus.NoRecord, records: [] }
        const missingAt = f.At(2)
        const missing = await f.domains.VerifyDomain('beta', 'beta.test')
        assert.deepEqual([missing.verified, missing.state, missing.lastCheckedAt], [false, DomainApprovalState.Pending, missingAt])
        await f.PublishOurs('beta', 'beta.test')
        await f.domains.VerifyDomain('beta', 'beta.test')
        f.resolver.answer = { status: TxtLookupStatus.Found, records: [[DomainVerificationRecord.ValueFor(DomainVerificationRecord.NewToken())]] }
        const changedAt = f.At(3)
        const changed = await f.domains.VerifyDomain('beta', 'beta.test')
        assert.deepEqual([changed.verified, changed.state, changed.lastCheckedAt], [false, DomainApprovalState.Pending, changedAt])
        const row = (await f.domains.Report('beta'))?.approvals?.[0]
        assert.deepEqual([row?.verified, row?.lastCheckedAt], [false, changedAt])
    })

    it('a failed lookup throws DomainVerificationUnavailableError and leaves verified and lastCheckedAt unchanged', async () =>
    {
        await f.domains.Set('beta', ['beta.test'])
        await f.PublishOurs('beta', 'beta.test')
        const verifiedAt = f.At(1)
        await f.domains.VerifyDomain('beta', 'beta.test')
        const stored = f.approvals.VerificationOf('beta', 'beta.test')
        f.resolver.answer = { status: TxtLookupStatus.Failed, records: [] }
        f.At(2)
        await assert.rejects(f.domains.VerifyDomain('beta', 'Beta.TEST'),
            (e: Error) => e instanceof DomainVerificationUnavailableError && e.message === 'The DNS lookup for _pragmatic-verification.beta.test did not complete. Try again later.')
        assert.deepEqual(f.approvals.VerificationOf('beta', 'beta.test'), stored)
        assert.deepEqual([stored?.verified, stored?.lastCheckedAt], [true, verifiedAt])
    })

    it('after 10 lookups for one tenant in the window, the next throws DomainVerifyThrottledError without a lookup, and another tenant is unaffected', async () =>
    {
        await f.domains.Set('beta', ['beta.test'])
        await f.Advertise(['acme.test'])
        for (let i = 0; i < 10; i++)
        {
            await f.domains.VerifyDomain('beta', 'beta.test')
        }
        assert.equal(f.resolver.Names.length, 10)
        await assert.rejects(f.domains.VerifyDomain('beta', 'beta.test'),
            (e: Error) => e instanceof DomainVerifyThrottledError && e.message === 'Too many verification attempts for this tenant. Try again in a few minutes.')
        await assert.rejects(f.domains.VerifyDomain('beta', 'beta.test'), DomainVerifyThrottledError)
        assert.equal(f.resolver.Names.length, 10)
        await f.domains.VerifyDomain('acme', 'acme.test')
        assert.equal(f.resolver.Names.length, 11)
    })

    it('the operator\'s verify has its own throttle: after 10 tenant-side lookups the tenant side is refused and the operator\'s still runs', async () =>
    {
        await f.domains.Set('beta', ['beta.test'])
        for (let i = 0; i < 10; i++)
        {
            await f.domains.Verify('beta', 'beta.test')
        }
        await assert.rejects(f.domains.Verify('beta', 'beta.test'), DomainVerifyThrottledError)
        assert.equal(f.resolver.Names.length, 10)
        const answer = await f.domains.VerifyDomainAsOperator('beta', 'beta.test')
        assert.equal(answer.domain, 'beta.test')
        assert.equal(f.resolver.Names.length, 11)
        for (let i = 1; i < 10; i++)
        {
            await f.domains.VerifyDomainAsOperator('beta', 'beta.test')
        }
        await assert.rejects(f.domains.VerifyDomainAsOperator('beta', 'beta.test'), DomainVerifyThrottledError)
        assert.equal(f.resolver.Names.length, 20)
    })

    it('VerifyDomain refuses an unclaimed domain (DomainNotClaimedError) and a malformed one (InvalidEmailDomainError), before any lookup', async () =>
    {
        await f.domains.Set('beta', ['beta.test'])
        await assert.rejects(f.domains.VerifyDomain('beta', 'Other.TEST'),
            (e: Error) => e instanceof DomainNotClaimedError && e.message === "other.test is not among this tenant's email domains, so there is nothing to verify.")
        await assert.rejects(f.domains.VerifyDomain('beta', 'not a domain'), InvalidEmailDomainError)
        await assert.rejects(f.domains.VerifyDomain('nope', 'beta.test'), UnknownTenantError)
        assert.equal(f.resolver.Names.length, 0)
        assert.equal(f.approvals.VerificationOf('beta', 'other.test'), undefined)
    })

    it('without a verifier VerifyDomain throws DomainVerificationUnavailableError', async () =>
    {
        await f.domains.Set('beta', ['beta.test'])
        const unverifying = new PlatformEmailDomains(f.directory, f.adverts, f.approvals)
        await assert.rejects(unverifying.VerifyDomain('beta', 'beta.test'),
            (e: Error) => e instanceof DomainVerificationUnavailableError && e.message === 'DNS verification is not available on this control plane.')
        await assert.rejects(unverifying.Verify('beta', 'beta.test'), DomainVerificationUnavailableError)
    })

    it('AnswersFor issues tokens and answers states in the given order', async () =>
    {
        await f.directory.SetTenantEmailDomains('beta', ['shared.test'])
        await f.Advertise(['acme.test', 'shared.test', 'two.test'])
        await f.domains.Approve('acme', 'two.test')
        const answers = await f.domains.AnswersFor('acme', ['two.test', 'Shared.TEST', 'acme.test'])
        assert.deepEqual(answers.map(a => [a.domain, a.state, a.verified]), [
            ['two.test', DomainApprovalState.Approved, false],
            ['shared.test', DomainApprovalState.Pending, false],
            ['acme.test', DomainApprovalState.Pending, false],
        ])
        assert.deepEqual(answers.map(a => a.token), answers.map(a => f.approvals.VerificationOf('acme', a.domain)?.token))
        assert.ok(answers.every(a => DomainVerificationRecord.IsToken(a.token)))
        await f.PublishOurs('acme', 'shared.test')
        await f.domains.VerifyDomain('acme', 'shared.test')
        assert.equal((await f.domains.AnswersFor('acme', ['shared.test']))[0]?.state, DomainApprovalState.VerifiedContested)
    })

    it('AnswersFor refuses an unknown tenant and a malformed domain and writes nothing', async () =>
    {
        await f.Advertise(['acme.test'])
        await assert.rejects(f.domains.AnswersFor('nope', ['acme.test']), UnknownTenantError)
        await assert.rejects(f.domains.AnswersFor('acme', ['acme.test', 'not a domain']), InvalidEmailDomainError)
        assert.equal(f.approvals.Get('nope'), undefined)
        assert.equal(f.approvals.Get('acme'), undefined)
    })
})
