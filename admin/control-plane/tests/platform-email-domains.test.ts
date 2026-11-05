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

    it('a control-plane tenant reports its record domains as editable', async () =>
    {
        await f.directory.SetTenantEmailDomains('beta', ['beta.test'])
        assert.equal(f.domains.IsInHive('beta'), false)
        assert.deepEqual(f.domains.Report('beta'), { tenantId: 'beta', domains: ['beta.test'], source: EmailDomainSource.Tenant, editable: true, sharedWith: [] })
        assert.deepEqual(f.domains.For('beta'), { domains: ['beta.test'], editable: true })
    })

    it('an in-hive tenant reports its advert domains read-only with the report time', async () =>
    {
        await f.Advertise(['acme.test'])
        assert.equal(f.domains.IsInHive('acme'), true)
        const report = f.domains.Report('acme')
        assert.deepEqual(report, {
            tenantId: 'acme', domains: ['acme.test'], source: EmailDomainSource.Console, editable: false, reportedAt: DomainsFixture.ReportedAt, sharedWith: [],
            approvals: [{ domain: 'acme.test', approved: false, sharedWith: [] }],
        })
        assert.deepEqual(f.domains.For('acme'), { domains: ['acme.test'], editable: false })
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
        assert.equal(f.directory.GetTenant('acme')?.emailDomains, undefined)
    })

    it('Set stores a control-plane tenant\'s domains normalised', async () =>
    {
        assert.deepEqual(await f.domains.Set('beta', ['Beta.TEST', 'beta.test']), { domains: ['beta.test'], editable: true })
        assert.deepEqual(f.directory.GetTenant('beta')?.emailDomains, ['beta.test'])
        await assert.rejects(f.domains.Set('beta', ['gmail.com']), InvalidEmailDomainError)
    })

    it('an unknown tenant reads as none and cannot be set', async () =>
    {
        assert.equal(f.domains.Report('nope'), undefined)
        assert.deepEqual(f.domains.For('nope'), { domains: [], editable: false })
        await assert.rejects(f.domains.Set('nope', []), UnknownTenantError)
    })

    it('sharedWith names other tenants claiming the same domain', async () =>
    {
        await f.directory.SetTenantEmailDomains('beta', ['shared.test', 'beta.test'])
        await f.Advertise(['shared.test', 'acme.test'])
        assert.deepEqual(f.domains.Report('beta')?.sharedWith, ['acme'])
        const acme = f.domains.Report('acme')
        assert.deepEqual(acme?.sharedWith, ['beta'])
        assert.deepEqual(acme?.approvals, [{ domain: 'acme.test', approved: false, sharedWith: [] }, { domain: 'shared.test', approved: false, sharedWith: ['beta'] }])
    })

    it('Approve marks an advertised domain approved and Revoke withdraws it', async () =>
    {
        await f.Advertise(['acme.test'])
        await f.domains.Approve('acme', ' Acme.TEST ')
        assert.deepEqual(f.approvals.ApprovedFor('acme'), ['acme.test'])
        assert.deepEqual(f.domains.Report('acme')?.approvals, [{ domain: 'acme.test', approved: true, sharedWith: [] }])
        await f.domains.Revoke('acme', 'acme.test')
        assert.deepEqual(f.approvals.ApprovedFor('acme'), [])
    })

    it('Revoke of a never-approved domain changes nothing', async () =>
    {
        await f.Advertise(['acme.test', 'two.test'])
        await f.domains.Approve('acme', 'acme.test')
        await f.domains.Revoke('acme', 'two.test')
        await f.domains.Revoke('beta', 'beta.test')
        assert.deepEqual(f.approvals.ApprovedFor('acme'), ['acme.test'])
        assert.deepEqual(f.approvals.ApprovedFor('beta'), [])
    })

    it('Revoke clears a stored approval the policy now refuses', async () =>
    {
        await f.approvals.Put({ id: 'acme', tenantId: 'acme', domains: ['acme.test', 'gmail.com'] })
        await f.domains.Revoke('acme', 'Gmail.COM')
        assert.deepEqual(f.approvals.ApprovedFor('acme'), ['acme.test'])
    })

    it('Approve refuses a domain the console does not advertise', async () =>
    {
        await f.Advertise(['acme.test'])
        await assert.rejects(f.domains.Approve('acme', 'other.test'),
            (e: Error) => e instanceof EmailDomainApprovalRefusedError && e.message === "other.test is not among the email domains this tenant's console reports, so there is nothing to approve.")
        assert.deepEqual(f.approvals.ApprovedFor('acme'), [])
    })

    it('Approve refuses a control-plane tenant, a public mail domain and an unknown tenant', async () =>
    {
        await f.directory.SetTenantEmailDomains('beta', ['beta.test'])
        await assert.rejects(f.domains.Approve('beta', 'beta.test'),
            (e: Error) => e instanceof EmailDomainApprovalRefusedError && e.message === "This tenant's console runs on the control plane; its email domains take effect without approval.")
        await assert.rejects(f.domains.Approve('acme', 'gmail.com'), InvalidEmailDomainError)
        await assert.rejects(f.domains.Approve('nope', 'acme.test'), UnknownTenantError)
        await assert.rejects(f.domains.Revoke('nope', 'acme.test'), UnknownTenantError)
    })

    it('an approval survives a re-advert, and a dropped domain no longer shows', async () =>
    {
        await f.Advertise(['acme.test', 'two.test'])
        await f.domains.Approve('acme', 'two.test')
        await f.Advertise(['acme.test'])
        assert.deepEqual(f.domains.Report('acme')?.approvals, [{ domain: 'acme.test', approved: false, sharedWith: [] }])
        await f.Advertise(['acme.test', 'two.test'])
        assert.deepEqual(f.domains.Report('acme')?.approvals?.find(a => a.domain === 'two.test')?.approved, true)
    })

    it('after the console is removed the record domains count again', async () =>
    {
        await f.directory.SetTenantEmailDomains('acme', ['old.test'])
        await f.Advertise(['acme.test'])
        await f.directory.SetHiveConsole('acme-hive', undefined)
        assert.deepEqual(f.domains.Report('acme'), { tenantId: 'acme', domains: ['old.test'], source: EmailDomainSource.Tenant, editable: true, sharedWith: [] })
    })

    it('without an approval store Approve is refused', async () =>
    {
        await f.Advertise(['acme.test'])
        const bare = new PlatformEmailDomains(f.directory, f.adverts)
        await assert.rejects(bare.Approve('acme', 'acme.test'), EmailDomainApprovalRefusedError)
        assert.deepEqual(bare.Report('acme')?.approvals, [{ domain: 'acme.test', approved: false, sharedWith: [] }])
    })
})
