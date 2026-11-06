import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ClientRegistry } from '../client-registry.js'
import { ConsoleAdvertRegistry } from '../console-advert-registry.js'
import { ConsoleDomainApprovals } from '../console-domain-approvals.js'
import { InvalidEmailDomainError } from '../email-domain-policy.js'
import { HiveRegistry } from '../hive-registry.js'
import { IngressTlsSource } from '../ingress-tls.js'
import { PlatformDirectory, UnknownTenantError } from '../platform-directory.js'
import { EmailDomainApprovalRefusedError, EmailDomainSource, PlatformEmailDomains } from '../platform-email-domains.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import { TenantRegistry } from '../tenant-registry.js'
import { EmailDomainsNotEditableError } from '../tenant-api/tenant-email-domains.js'

class DomainsFixture
{
    public static readonly ReportedAt = '2026-11-04T10:00:00.000Z'
    public static readonly Spec = { cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } }

    public dir = ''
    public directory!: PlatformDirectory
    public adverts!: ConsoleAdvertRegistry
    public approvals!: ConsoleDomainApprovals
    public domains!: PlatformEmailDomains

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
        this.domains = new PlatformEmailDomains(this.directory, this.adverts, this.approvals)
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
        assert.deepEqual(f.domains.Report('beta'), {
            tenantId: 'beta', domains: ['beta.test'], source: EmailDomainSource.Tenant, editable: true, sharedWith: [],
            approvals: [{ domain: 'beta.test', approved: false, claimed: true, sharedWith: [] }],
        })
        assert.deepEqual(f.domains.For('beta'), { domains: ['beta.test'], editable: true, inHive: false, pending: ['beta.test'] })
    })

    it('an in-hive tenant reports its advert domains read-only with the report time', async () =>
    {
        await f.Advertise(['acme.test'])
        assert.equal(f.domains.IsInHive('acme'), true)
        const report = f.domains.Report('acme')
        assert.deepEqual(report, {
            tenantId: 'acme', domains: ['acme.test'], source: EmailDomainSource.Console, editable: false, reportedAt: DomainsFixture.ReportedAt, sharedWith: [],
            approvals: [{ domain: 'acme.test', approved: false, claimed: true, sharedWith: [] }],
        })
        assert.deepEqual(f.domains.For('acme'), { domains: ['acme.test'], editable: false, inHive: true, pending: ['acme.test'] })
    })

    it('an in-hive tenant without an advert reports none', async () =>
    {
        assert.deepEqual(f.domains.Report('acme'), { tenantId: 'acme', domains: [], source: EmailDomainSource.Console, editable: false, sharedWith: [], approvals: [] })
    })

    it('an in-hive tenant ignores the domains left in its record', async () =>
    {
        await f.directory.SetTenantEmailDomains('acme', ['old.test'])
        await f.Advertise(['acme.test'])
        assert.deepEqual(f.domains.Report('acme')?.domains, ['acme.test'])
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
        assert.deepEqual(await f.domains.Set('beta', ['Beta.TEST', 'beta.test']), { domains: ['beta.test'], editable: true, inHive: false, pending: ['beta.test'] })
        assert.deepEqual(f.directory.GetTenant('beta')?.emailDomains, ['beta.test'])
        assert.deepEqual(f.approvals.ApprovedFor('beta'), [])
        await assert.rejects(f.domains.Set('beta', ['gmail.com']), InvalidEmailDomainError)
    })

    it('an Owner-set domain takes effect once an operator approves it', async () =>
    {
        await f.domains.Set('beta', ['beta.test', 'victim.test'])
        assert.equal(await f.domains.Approve('beta', ' Beta.TEST '), 'beta.test')
        assert.deepEqual(f.approvals.ApprovedFor('beta'), ['beta.test'])
        assert.deepEqual(f.domains.For('beta').pending, ['victim.test'])
        assert.deepEqual(f.domains.Report('beta')?.approvals, [
            { domain: 'beta.test', approved: true, claimed: true, sharedWith: [] },
            { domain: 'victim.test', approved: false, claimed: true, sharedWith: [] },
        ])
    })

    it('SetAsOperator stores the domains and approves each one it saved', async () =>
    {
        await f.domains.Set('beta', ['owner.test'])
        await f.domains.SetAsOperator('beta', ['Beta.TEST', 'eu.beta.test'])
        assert.deepEqual(f.directory.GetTenant('beta')?.emailDomains, ['beta.test', 'eu.beta.test'])
        assert.deepEqual(f.approvals.ApprovedFor('beta'), ['beta.test', 'eu.beta.test'])
        assert.deepEqual(f.domains.For('beta').pending, [])
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
        assert.deepEqual(f.domains.For('beta').pending, ['victim.test'])
        assert.deepEqual(await f.domains.SetAsOperator('beta', ['victim.test', 'beta.test']), [])
        assert.deepEqual(f.approvals.ApprovedFor('beta'), ['beta.test'])
    })

    it('an unknown tenant reads as none and cannot be set', async () =>
    {
        assert.equal(f.domains.Report('nope'), undefined)
        assert.deepEqual(f.domains.For('nope'), { domains: [], editable: false, inHive: false, pending: [] })
        await assert.rejects(f.domains.Set('nope', []), UnknownTenantError)
    })

    it('sharedWith names other tenants claiming the same domain', async () =>
    {
        await f.directory.SetTenantEmailDomains('beta', ['shared.test', 'beta.test'])
        await f.Advertise(['shared.test', 'acme.test'])
        assert.deepEqual(f.domains.Report('beta')?.sharedWith, ['acme'])
        const acme = f.domains.Report('acme')
        assert.deepEqual(acme?.sharedWith, ['beta'])
        assert.deepEqual(acme?.approvals, [
            { domain: 'acme.test', approved: false, claimed: true, sharedWith: [] },
            { domain: 'shared.test', approved: false, claimed: true, sharedWith: ['beta'] },
        ])
    })

    it('Approve marks an advertised domain approved and Revoke withdraws it', async () =>
    {
        await f.Advertise(['acme.test'])
        await f.domains.Approve('acme', ' Acme.TEST ')
        assert.deepEqual(f.approvals.ApprovedFor('acme'), ['acme.test'])
        assert.deepEqual(f.domains.Report('acme')?.approvals, [{ domain: 'acme.test', approved: true, claimed: true, sharedWith: [] }])
        assert.deepEqual(f.domains.For('acme').pending, [])
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
        assert.deepEqual(f.domains.Report('acme')?.approvals, [
            { domain: 'acme.test', approved: false, claimed: true, sharedWith: [] },
            { domain: 'two.test', approved: true, claimed: false, sharedWith: [] },
        ])
        assert.deepEqual(f.domains.For('acme').pending, ['acme.test'])
        await f.Advertise(['acme.test', 'two.test'])
        assert.deepEqual(f.domains.Report('acme')?.approvals?.find(a => a.domain === 'two.test'), { domain: 'two.test', approved: true, claimed: true, sharedWith: [] })
        await f.Advertise(['acme.test'])
        await f.domains.Revoke('acme', 'two.test')
        assert.deepEqual(f.domains.Report('acme')?.approvals?.map(a => a.domain), ['acme.test'])
    })

    it('an operator-approved domain removed from a control-plane record is listed as no longer claimed', async () =>
    {
        await f.domains.SetAsOperator('beta', ['beta.test', 'old.test'])
        await f.domains.SetAsOperator('beta', ['beta.test'])
        assert.deepEqual(f.domains.Report('beta')?.approvals, [
            { domain: 'beta.test', approved: true, claimed: true, sharedWith: [] },
            { domain: 'old.test', approved: true, claimed: false, sharedWith: [] },
        ])
    })

    it('after the console is removed the record domains count again', async () =>
    {
        await f.directory.SetTenantEmailDomains('acme', ['old.test'])
        await f.Advertise(['acme.test'])
        await f.directory.SetHiveConsole('acme-hive', undefined)
        assert.deepEqual(f.domains.Report('acme'), {
            tenantId: 'acme', domains: ['old.test'], source: EmailDomainSource.Tenant, editable: true, sharedWith: [],
            approvals: [{ domain: 'old.test', approved: false, claimed: true, sharedWith: [] }],
        })
    })

    it('without an approval store Approve is refused and every domain stays pending', async () =>
    {
        await f.Advertise(['acme.test'])
        const bare = new PlatformEmailDomains(f.directory, f.adverts)
        await assert.rejects(bare.Approve('acme', 'acme.test'), EmailDomainApprovalRefusedError)
        assert.deepEqual(bare.Report('acme')?.approvals, [{ domain: 'acme.test', approved: false, claimed: true, sharedWith: [] }])
        await bare.SetAsOperator('beta', ['beta.test'])
        assert.deepEqual(bare.For('beta').pending, ['beta.test'])
    })
})
