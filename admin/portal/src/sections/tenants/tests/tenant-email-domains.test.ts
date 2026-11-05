import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../../../api-client.js'
import { OperatorContext } from '../../../operator-context.js'
import { EmailDomainSource, type TenantEmailDomainsDto } from '../../../portal-types.js'
import { FakeControlPlane, PortalTestHost, TestRail, Tick } from '../../../shell/tests/portal-test-fixtures.js'
import { TenantDetailPageViewModel } from '../tenant-detail-page-view-model.js'
import { TenantEmailDomainsViewModel } from '../tenant-email-domains-view-model.js'
import { TenantsPageViewModel } from '../tenants-page-view-model.js'
import { TenantsSectionService } from '../tenants-section-service.js'

// One tenant t1 of client acme over a fake control plane; a bare email-domains block, or the tenant page behind a rail.
class DomainsFixture
{
    public readonly Api: FakeControlPlane
    public readonly Host: PortalTestHost

    public constructor(wireRole: string = OperatorContext.FullWireRole)
    {
        this.Api = new FakeControlPlane()
            .WithClient('acme', 'Acme')
            .WithTenant('t1', 'acme', 'Acme Production')
        this.Host = new PortalTestHost(this.Api.AsClient(), wireRole)
        this.Host.UseDialogs()
    }

    public Report(report: Partial<TenantEmailDomainsDto>): this
    {
        this.Api.EmailDomainReports.set('t1', { tenantId: 't1', domains: [], source: EmailDomainSource.Tenant, editable: true, sharedWith: [], approvals: [], ...report })
        return this
    }

    // An in-hive tenant whose console reported acme.test (approved) and beta.test (pending, also claimed by t2).
    public InHive(): this
    {
        return this.Report({
            domains: ['acme.test', 'beta.test'], source: EmailDomainSource.Console, editable: false, reportedAt: '2026-11-04T10:30:00.000Z', sharedWith: ['t2'],
            approvals: [
                { domain: 'acme.test', approved: true, claimed: true, sharedWith: [] },
                { domain: 'beta.test', approved: false, claimed: true, sharedWith: ['t2'] },
            ],
        })
    }

    // A control-plane tenant: acme.test (saved by an operator, so approved) and owner.test (set by the tenant Owner, pending).
    public ControlPlane(): this
    {
        return this.Report({
            domains: ['acme.test', 'owner.test'],
            approvals: [
                { domain: 'acme.test', approved: true, claimed: true, sharedWith: [] },
                { domain: 'owner.test', approved: false, claimed: true, sharedWith: [] },
            ],
        })
    }

    public async Loaded(): Promise<TenantEmailDomainsViewModel>
    {
        const block = new TenantEmailDomainsViewModel(this.Host.Session, 't1')
        await block.Load()
        return block
    }

    public async Detail(): Promise<TenantDetailPageViewModel>
    {
        this.Host.Provider.register(TenantsSectionService.Key, (p) => new TenantsSectionService(p))
        const rail = new TestRail(this.Host.Provider)
        rail.Add(TenantsSectionService)
        rail.Select(TenantsSectionService)
        await Tick.Settle()
        const content = this.Host.Host.Content
        assert.ok(content instanceof TenantsPageViewModel)
        content.OpenCommand.Execute(content.Rows.Get(0))
        await Tick.Settle()
        const detail = this.Host.Host.Content
        assert.ok(detail instanceof TenantDetailPageViewModel)
        return detail
    }
}

describe('Tenant email domains', () =>
{
    it('a control-plane tenant edits its domains', async () =>
    {
        const fx = new DomainsFixture().Report({ domains: ['acme.test', 'acme.example'] })
        const block = await fx.Loaded()
        assert.equal(block.DomainsText, 'acme.test, acme.example')
        assert.equal(block.DomainsLabel, 'acme.test, acme.example')
        assert.equal(block.IsEditable, true)
        assert.equal(block.IsReadOnly, false)
        assert.equal(block.SourceText, '')
        assert.equal(block.SaveCommand.CanExecute(), false)
        block.DomainsText = 'acme.test,  beta.test'
        assert.equal(block.SaveCommand.CanExecute(), true)
        block.SaveCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.EmailDomainSaves, [['t1', ['acme.test', 'beta.test']]])
        assert.equal(block.SavedText, 'Saved. Approved on save: beta.test.')
        assert.equal(block.ErrorText, '')
        assert.equal(block.DomainsText, 'acme.test, beta.test')
        assert.equal(block.SaveCommand.CanExecute(), false)
        block.DomainsText = 'acme.test; gamma.test'
        assert.equal(block.SavedText, '')
    })

    it('a list with no domains says none are declared, and the text splits on spaces, commas and semicolons', async () =>
    {
        const fx = new DomainsFixture()
        const block = await fx.Loaded()
        assert.equal(block.DomainsLabel, 'None declared.')
        assert.equal(block.DomainsText, '')
        block.DomainsText = ' a.test ;b.test\n c.test,, '
        await block.Save()
        assert.deepEqual(fx.Api.EmailDomainSaves, [['t1', ['a.test', 'b.test', 'c.test']]])
    })

    it('an in-hive tenant shows the reported domains read-only', async () =>
    {
        const fx = new DomainsFixture().InHive()
        const block = await fx.Loaded()
        assert.equal(block.IsEditable, false)
        assert.equal(block.IsReadOnly, true)
        assert.equal(block.IsInHive, true)
        assert.equal(block.SaveCommand.CanExecute(), false)
        assert.ok(block.SourceText.includes('in its hive'))
        assert.equal(block.SourceText, 'Reported by the tenant console in its hive on 2026-11-04 10:30. The tenant Owner changes them there.')
        await block.Save()
        assert.deepEqual(fx.Api.EmailDomainSaves, [])
    })

    it('an in-hive tenant lists each reported domain as Approved or Pending with Approve / Revoke', async () =>
    {
        const fx = new DomainsFixture().InHive()
        const block = await fx.Loaded()
        assert.equal(block.HasApprovals, true)
        const rows = block.Approvals.ToArray()
        assert.deepEqual(rows.map(r => [r.Domain, r.StatusLabel, r.SharedWithText]), [
            ['acme.test', 'Approved', ''],
            ['beta.test', 'Pending', 'Also claimed by: t2'],
        ])
        const [approved, pending] = rows
        assert.equal(approved!.ApproveCommand.CanExecute(), false)
        assert.equal(approved!.RevokeCommand.CanExecute(), true)
        assert.equal(approved!.CanApprove, false)
        assert.equal(approved!.CanRevoke, true)
        assert.equal(pending!.ApproveCommand.CanExecute(), true)
        assert.equal(pending!.RevokeCommand.CanExecute(), false)
        pending!.ApproveCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.EmailDomainActions, ['Approve t1 beta.test'])
        assert.deepEqual(block.Approvals.ToArray().map(r => r.StatusLabel), ['Approved', 'Approved'])
        block.Approvals.Get(0)!.RevokeCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.EmailDomainActions, ['Approve t1 beta.test', 'Revoke t1 acme.test'])
        assert.deepEqual(block.Approvals.ToArray().map(r => r.StatusLabel), ['Pending', 'Approved'])
    })

    it('a refused approval shows its sentence in the block', async () =>
    {
        const fx = new DomainsFixture().InHive()
        const block = await fx.Loaded()
        fx.Api.EmailDomainsFailure = new ApiError(409, "beta.test is not among the email domains this tenant's console reports, so there is nothing to approve.")
        await block.Approvals.Get(1)!.Approve()
        assert.equal(block.ErrorText, "beta.test is not among the email domains this tenant's console reports, so there is nothing to approve.")
        assert.equal(block.Approvals.Get(1)!.StatusLabel, 'Pending')
    })

    it('a refused approval reloads the rows, keeping the refusal sentence', async () =>
    {
        const fx = new DomainsFixture().InHive()
        const block = await fx.Loaded()
        // The console has since stopped reporting beta.test.
        fx.Api.EmailDomainReports.set('t1', {
            ...fx.Api.EmailDomainReports.get('t1')!, domains: ['acme.test'], sharedWith: [],
            approvals: [{ domain: 'acme.test', approved: true, claimed: true, sharedWith: [] }],
        })
        fx.Api.EmailDomainsFailure = new ApiError(409, "beta.test is not among the email domains this tenant's console reports, so there is nothing to approve.")
        const reads = fx.Api.EmailDomainReads
        await block.Approvals.Get(1)!.Approve()
        assert.equal(fx.Api.EmailDomainReads, reads + 1)
        assert.deepEqual(block.Approvals.ToArray().map(r => r.Domain), ['acme.test'])
        assert.equal(block.ErrorText, "beta.test is not among the email domains this tenant's console reports, so there is nothing to approve.")
    })

    it('a refused revoke reloads the rows too; an expired session does not reload', async () =>
    {
        const fx = new DomainsFixture().InHive()
        const block = await fx.Loaded()
        fx.Api.EmailDomainsFailure = new ApiError(503, 'The approval store is unavailable.')
        const reads = fx.Api.EmailDomainReads
        await block.Approvals.Get(0)!.Revoke()
        assert.equal(fx.Api.EmailDomainReads, reads + 1)
        assert.equal(block.ErrorText, 'The approval store is unavailable.')
        fx.Api.EmailDomainsFailure = new ApiError(401, 'Sign in again.')
        await block.Approvals.Get(0)!.Revoke()
        assert.equal(fx.Api.EmailDomainReads, reads + 1)
        assert.equal(fx.Host.Reloader.Count, 1)
    })

    it('a control-plane tenant edits its list and lists each domain with its approval', async () =>
    {
        const fx = new DomainsFixture().ControlPlane()
        const block = await fx.Loaded()
        assert.equal(block.IsInHive, false)
        assert.equal(block.IsEditable, true)
        assert.equal(block.HasApprovals, true)
        assert.equal(block.HasDomainsLabel, false)
        assert.equal(block.ApprovalsCaption,
            'A domain sends people to this tenant only once it is approved. Domains you add here are approved on save; those the tenant Owner sets wait here for approval.')
        assert.deepEqual(block.Approvals.ToArray().map(r => [r.Domain, r.StatusLabel, r.CanApprove, r.CanRevoke]), [
            ['acme.test', 'Approved', false, true],
            ['owner.test', 'Pending', true, false],
        ])
        await block.Approvals.Get(1)!.Approve()
        assert.deepEqual(fx.Api.EmailDomainActions, ['Approve t1 owner.test'])
        assert.deepEqual(block.Approvals.ToArray().map(r => r.StatusLabel), ['Approved', 'Approved'])
    })

    it('a save approves only the domains it adds and names them; the Owner\'s pending domain stays pending', async () =>
    {
        const fx = new DomainsFixture().ControlPlane()
        const block = await fx.Loaded()
        block.DomainsText = 'acme.test, owner.test, new.test'
        await block.Save()
        assert.equal(block.SavedText, 'Saved. Approved on save: new.test.')
        assert.deepEqual(block.Approvals.ToArray().map(r => [r.Domain, r.StatusLabel]), [
            ['acme.test', 'Approved'], ['owner.test', 'Pending'], ['new.test', 'Approved'],
        ])
        block.DomainsText = 'acme.test, owner.test'
        await block.Save()
        assert.equal(block.SavedText, 'Saved.')
    })

    it('an in-hive tenant gets the reported-domain caption', async () =>
    {
        const block = await new DomainsFixture().InHive().Loaded()
        assert.equal(block.ApprovalsCaption, 'A reported domain sends people to this tenant only once it is approved.')
    })

    it('an approved domain the tenant no longer claims is marked so and offers Revoke only', async () =>
    {
        const fx = new DomainsFixture().InHive()
        fx.Api.EmailDomainReports.set('t1', {
            ...fx.Api.EmailDomainReports.get('t1')!,
            approvals: [...fx.Api.EmailDomainReports.get('t1')!.approvals, { domain: 'gone.test', approved: true, claimed: false, sharedWith: [] }],
        })
        const block = await fx.Loaded()
        const gone = block.Approvals.Get(2)!
        assert.equal(gone.Domain, 'gone.test')
        assert.equal(gone.StatusLabel, 'Approved, no longer claimed')
        assert.equal(gone.CanApprove, false)
        assert.equal(gone.CanRevoke, true)
        await gone.Revoke()
        assert.deepEqual(fx.Api.EmailDomainActions, ['Revoke t1 gone.test'])
    })

    it('a control-plane tenant with no domains has no approval rows', async () =>
    {
        const fx = new DomainsFixture().Report({ domains: [] })
        const block = await fx.Loaded()
        assert.equal(block.HasApprovals, false)
        assert.equal(block.Approvals.Count, 0)
    })

    it('a 400 shows the server sentence', async () =>
    {
        const fx = new DomainsFixture().Report({ domains: ['acme.test'] })
        const block = await fx.Loaded()
        block.DomainsText = 'gmail.com'
        fx.Api.EmailDomainsFailure = new ApiError(400, 'gmail.com is a public email provider; it cannot route sign-ins to one tenant.')
        await block.Save()
        assert.equal(block.ErrorText, 'gmail.com is a public email provider; it cannot route sign-ins to one tenant.')
        assert.equal(block.SavedText, '')
        assert.equal(block.DomainsText, 'gmail.com')
        assert.equal(block.SaveCommand.CanExecute(), true)
    })

    it('a read-only operator cannot save', async () =>
    {
        const fx = new DomainsFixture(OperatorContext.ReadOnlyWireRole).Report({ domains: ['acme.test'] })
        const block = await fx.Loaded()
        assert.equal(block.IsEditable, false)
        assert.equal(block.IsReadOnly, true)
        block.DomainsText = 'beta.test'
        assert.equal(block.SaveCommand.CanExecute(), false)
        await block.Save()
        assert.deepEqual(fx.Api.EmailDomainSaves, [])
    })

    it('a read-only operator sees no approval action', async () =>
    {
        const fx = new DomainsFixture(OperatorContext.ReadOnlyWireRole).InHive()
        const block = await fx.Loaded()
        for (const row of block.Approvals.ToArray())
        {
            assert.equal(row.CanApprove, false)
            assert.equal(row.CanRevoke, false)
            assert.equal(row.ApproveCommand.CanExecute(), false)
            assert.equal(row.RevokeCommand.CanExecute(), false)
            await row.Approve()
            await row.Revoke()
        }
        assert.deepEqual(fx.Api.EmailDomainActions, [])
    })

    it('a shared domain is called out', async () =>
    {
        const fx = new DomainsFixture().Report({ domains: ['acme.test'], sharedWith: ['beta'] })
        const block = await fx.Loaded()
        assert.equal(block.SharedWithText, 'Also claimed by: beta')
        const lone = await new DomainsFixture().Report({ domains: ['acme.test'] }).Loaded()
        assert.equal(lone.SharedWithText, '')
    })

    it('a 404 leaves the block read-only and says email domains are not available here', async () =>
    {
        const fx = new DomainsFixture()
        fx.Api.EmailDomainsReadFailure = new ApiError(404, 'not found')
        const block = await fx.Loaded()
        assert.equal(block.IsEditable, false)
        assert.equal(block.IsReadOnly, true)
        assert.equal(block.IsAvailable, false)
        assert.equal(block.NoticeText, 'Email domains are not available here.')
        assert.equal(block.ErrorText, '')
        assert.equal(block.SaveCommand.CanExecute(), false)
    })

    it('any other read failure shows its sentence in the block only', async () =>
    {
        const fx = new DomainsFixture()
        fx.Api.EmailDomainsReadFailure = new ApiError(500, 'The control plane could not read its tenants.')
        const block = await fx.Loaded()
        assert.equal(block.ErrorText, 'The control plane could not read its tenants.')
        assert.equal(block.IsEditable, false)
        assert.equal(block.SaveCommand.CanExecute(), false)
    })

    it('a reload keeps unsaved edits', async () =>
    {
        const fx = new DomainsFixture().Report({ domains: ['acme.test'] })
        const block = await fx.Loaded()
        block.DomainsText = 'acme.test, beta.test'
        await block.Load()
        assert.equal(block.DomainsText, 'acme.test, beta.test')
        assert.equal(block.SaveCommand.CanExecute(), true)
    })

    it('the tenant page loads the email domains with the tenant', async () =>
    {
        const fx = new DomainsFixture().Report({ domains: ['acme.test'] })
        const detail = await fx.Detail()
        assert.ok(detail.EmailDomains instanceof TenantEmailDomainsViewModel)
        assert.equal(detail.EmailDomains.DomainsText, 'acme.test')
        assert.equal(fx.Api.EmailDomainReads, 1)
    })

    it('a failing email-domain read never fails the tenant page', async () =>
    {
        const fx = new DomainsFixture()
        fx.Api.EmailDomainsReadFailure = new ApiError(404, 'not found')
        const detail = await fx.Detail()
        assert.equal(detail.IsPopulated, true)
        assert.equal(detail.EmailDomains.NoticeText, 'Email domains are not available here.')
        fx.Api.EmailDomainsReadFailure = new ApiError(503, 'The tenant records are unavailable.')
        await detail.Refresh()
        assert.equal(detail.IsPopulated, true)
        assert.equal(detail.ErrorText, '')
        assert.equal(detail.EmailDomains.ErrorText, 'The tenant records are unavailable.')
    })

    it('a 401 on the read expires the session', async () =>
    {
        const fx = new DomainsFixture()
        fx.Api.EmailDomainsReadFailure = new ApiError(401, 'Sign in again.')
        await fx.Loaded()
        assert.equal(fx.Host.Reloader.Count, 1)
    })
})
