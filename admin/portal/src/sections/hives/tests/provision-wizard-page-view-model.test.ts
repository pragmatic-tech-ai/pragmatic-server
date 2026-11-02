import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../../../api-client.js'
import { OperatorContext } from '../../../operator-context.js'
import { PendingSecret } from '../../../shell/holds-pending-secret.js'
import { FakeControlPlane, Inspect, PortalTestHost, TestRail, Tick } from '../../../shell/tests/portal-test-fixtures.js'
import { TenantDetailPageViewModel } from '../../tenants/tenant-detail-page-view-model.js'
import { TenantsPageViewModel } from '../../tenants/tenants-page-view-model.js'
import { TenantsSectionService } from '../../tenants/tenants-section-service.js'
import { HiveDetailPageViewModel } from '../hive-detail-page-view-model.js'
import { HivesPageViewModel } from '../hives-page-view-model.js'
import { HivesSectionService } from '../hives-section-service.js'
import { ProvisionStep, ProvisionWizardPageViewModel } from '../provision-wizard-page-view-model.js'

// The Hives and Tenants sections behind a real rail, over a fake control plane.
class WizardFixture
{
    public readonly Api: FakeControlPlane
    public readonly Host: PortalTestHost
    public readonly Clipboard: string[]
    public readonly Rail: TestRail

    public constructor(wireRole: string = OperatorContext.FullWireRole)
    {
        this.Api = new FakeControlPlane()
            .WithClient('acme', 'Acme')
            .WithTenant('acme-prod', 'acme', 'Acme Production')
            .WithHive('acme-hive', 'acme-prod')
        this.Host = new PortalTestHost(this.Api.AsClient(), wireRole)
        this.Host.UseDialogs()
        this.Clipboard = this.Host.UseClipboard()
        this.Host.Provider.register(HivesSectionService.Key, (p) => new HivesSectionService(p))
        this.Host.Provider.register(TenantsSectionService.Key, (p) => new TenantsSectionService(p))
        this.Rail = new TestRail(this.Host.Provider)
        this.Rail.Add(HivesSectionService)
        this.Rail.Add(TenantsSectionService)
    }

    public get Section(): HivesSectionService
    {
        return this.Host.Provider.getRequired(HivesSectionService.Key)
    }

    public get Content(): unknown
    {
        return this.Host.Host.Content
    }

    public async List(): Promise<HivesPageViewModel>
    {
        this.Rail.Select(HivesSectionService)
        await Tick.Settle()
        assert.ok(this.Content instanceof HivesPageViewModel)
        return this.Content
    }

    // Opens the wizard from the hives list.
    public async Wizard(): Promise<ProvisionWizardPageViewModel>
    {
        const list = await this.List()
        list.StandUpCommand.Execute()
        await Tick.Settle()
        assert.ok(this.Content instanceof ProvisionWizardPageViewModel)
        return this.Content
    }

    // Fills every step and stops on Review.
    public async AtReview(): Promise<ProvisionWizardPageViewModel>
    {
        const wizard = await this.Wizard()
        wizard.ClientId = 'initech'
        wizard.ClientDisplayName = 'Initech'
        wizard.NextCommand.Execute()
        wizard.TenantId = 'initech-prod'
        wizard.TenantDisplayName = 'Initech Production'
        wizard.OwnerEmail = 'owner@initech.test'
        wizard.NextCommand.Execute()
        wizard.HiveId = 'initech-hive'
        wizard.HiveDisplayName = 'Initech hive'
        wizard.CredentialRef = 'registry-pull/initech'
        wizard.NextCommand.Execute()
        assert.equal(wizard.StepIndex, ProvisionStep.Review)
        return wizard
    }

    // Provisions and stops on the Bootstrap reveal.
    public async Revealed(): Promise<ProvisionWizardPageViewModel>
    {
        const wizard = await this.AtReview()
        wizard.SubmitCommand.Execute()
        await Tick.Settle()
        assert.equal(wizard.StepIndex, ProvisionStep.Bootstrap)
        return wizard
    }
}

describe('Stand up a hive (provision wizard)', () =>
{
    it('Stand up a hive opens the wizard as a page of the Hives section', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.Wizard()
        assert.equal(fx.Section.Current, wizard)
        assert.equal(wizard.StepIndex, ProvisionStep.Client)
        assert.deepEqual(wizard.StepLabels, ['Client', 'Tenant', 'Hive', 'Review', 'Bootstrap'])
        assert.deepEqual(wizard.Steps.ToArray().map(s => [s.Label, s.IsCurrent]), [
            ['Client', true], ['Tenant', false], ['Hive', false], ['Review', false], ['Bootstrap', false],
        ])
    })

    it('Next is disabled until the current step validates; Back steps back', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.Wizard()
        assert.equal(wizard.NextCommand.CanExecute(), false)
        assert.equal(wizard.BackStepCommand.CanExecute(), false)
        wizard.ClientId = 'initech'
        assert.equal(wizard.NextCommand.CanExecute(), false)
        wizard.ClientDisplayName = '   '
        assert.equal(wizard.NextCommand.CanExecute(), false)
        wizard.ClientDisplayName = 'Initech'
        assert.equal(wizard.NextCommand.CanExecute(), true)
        wizard.NextCommand.Execute()
        assert.equal(wizard.StepIndex, ProvisionStep.Tenant)
        assert.equal(wizard.IsTenantStep, true)
        assert.equal(wizard.Steps.Get(1)?.IsCurrent, true)
        assert.equal(wizard.NextCommand.CanExecute(), false)
        wizard.NextCommand.Execute()
        assert.equal(wizard.StepIndex, ProvisionStep.Tenant)
        wizard.TenantId = 'initech-prod'
        wizard.TenantDisplayName = 'Initech Production'
        assert.equal(wizard.NextCommand.CanExecute(), false)
        wizard.OwnerEmail = 'owner@initech.test'
        assert.equal(wizard.NextCommand.CanExecute(), true)
        assert.equal(wizard.BackStepCommand.CanExecute(), true)
        wizard.BackStepCommand.Execute()
        assert.equal(wizard.StepIndex, ProvisionStep.Client)
        assert.equal(wizard.ClientId, 'initech')
    })

    it('Submit is offered on Review only, and the review summarises the input', async () =>
    {
        const wizard = await new WizardFixture().Wizard()
        assert.equal(wizard.SubmitCommand.CanExecute(), false)
        const atReview = await new WizardFixture().AtReview()
        assert.equal(atReview.NextCommand.CanExecute(), false)
        assert.equal(atReview.SubmitCommand.CanExecute(), true)
        assert.equal(atReview.ClusterSummary, 'Local / Attach existing')
        assert.equal(atReview.RegistrySummary, 'Attach existing')
    })

    it('Submit calls Provision once even when executed twice while in flight', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.AtReview()
        fx.Api.HoldCreates()
        wizard.SubmitCommand.Execute()
        wizard.SubmitCommand.Execute()
        await Tick.Settle()
        assert.equal(wizard.IsSubmitting, true)
        assert.equal(wizard.SubmitCommand.CanExecute(), false)
        assert.equal(wizard.BackStepCommand.CanExecute(), false)
        fx.Api.Release()
        await Tick.Settle()
        assert.equal(fx.Api.ProvisionCalls, 1)
        assert.equal(wizard.IsSubmitting, false)
        assert.deepEqual(fx.Api.Provisioned, [{
            client: { id: 'initech', displayName: 'Initech' },
            tenant: { id: 'initech-prod', displayName: 'Initech Production', ownerEmail: 'owner@initech.test' },
            hive: {
                id: 'initech-hive', displayName: 'Initech hive',
                cluster: { backend: 'local', mode: 'attach' },
                registry: { mode: 'attach', credentialRef: 'registry-pull/initech' },
            },
        }])
    })

    it('on success the Bootstrap step holds both one-time values and Finish waits for both saved flags', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.Revealed()
        assert.equal(wizard.IsBootstrapStep, true)
        assert.equal(wizard.ProvisionedHiveId, 'initech-hive')
        assert.equal(wizard.OwnerPassword, fx.Api.OwnerPassword)
        assert.equal(wizard.AgentToken, fx.Api.AgentToken)
        assert.equal(wizard.BackStepCommand.CanExecute(), false)
        assert.equal(wizard.CancelCommand.CanExecute(), false)
        assert.equal(wizard.SubmitCommand.CanExecute(), false)
        assert.equal(wizard.FinishCommand.CanExecute(), false)
        wizard.OwnerSaved = true
        assert.equal(wizard.FinishCommand.CanExecute(), false)
        wizard.FinishCommand.Execute()
        assert.equal(fx.Content, wizard)
        assert.equal(wizard.OwnerPassword, fx.Api.OwnerPassword)
        wizard.OwnerSaved = false
        wizard.AgentSaved = true
        assert.equal(wizard.FinishCommand.CanExecute(), false)
        wizard.OwnerSaved = true
        assert.equal(wizard.FinishCommand.CanExecute(), true)
    })

    it('Finish needs the Bootstrap step: saved flags alone before a provision do not enable it', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.AtReview()
        wizard.OwnerSaved = true
        wizard.AgentSaved = true
        assert.equal(wizard.FinishCommand.CanExecute(), false)
        assert.equal(wizard.HasPendingSecret, false)
    })

    it('raises HasPendingSecret when the one-time values appear and when Finish clears them', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.AtReview()
        const seen: Array<[unknown, unknown]> = []
        wizard.PropertyChanged(PendingSecret.ChangedProperty).subscribe(e => seen.push([e.oldValue, e.newValue]))
        wizard.SubmitCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(seen, [[false, true]])
        wizard.OwnerSaved = true
        wizard.AgentSaved = true
        wizard.FinishCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(seen, [[false, true], [true, false]])
        assert.equal(PendingSecret.IsHolder(wizard), true)
    })

    it('each one-time value copies to the clipboard with its own status', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.Revealed()
        assert.equal(wizard.HasPendingSecret, true)
        wizard.CopyOwnerPasswordCommand.Execute()
        await Tick.Settle()
        assert.equal(wizard.OwnerCopyStatus, 'Copied.')
        assert.equal(wizard.AgentCopyStatus, '')
        wizard.CopyAgentTokenCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Clipboard, [fx.Api.OwnerPassword, fx.Api.AgentToken])
        assert.equal(wizard.AgentCopyStatus, 'Copied.')
    })

    it('a field change raises its own notification on the page, once', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.Wizard()
        let raised = 0
        const subscription = wizard.PropertyChanged('ClientId').subscribe(() => { raised++ })
        wizard.ClientId = 'initech'
        wizard.ClientId = 'initech'
        subscription.dispose()
        assert.equal(raised, 1)
    })

    it('a cross-section open of a hive keeps the revealed wizard current, with its values', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.Revealed()
        fx.Rail.Select(TenantsSectionService)
        await Tick.Settle()
        const tenants = fx.Content
        assert.ok(tenants instanceof TenantsPageViewModel)
        tenants.OpenCommand.Execute(tenants.Rows.ToArray().find(r => r.Id === 'acme-prod'))
        await Tick.Settle()
        const tenant = fx.Content
        assert.ok(tenant instanceof TenantDetailPageViewModel)
        tenant.OpenHiveCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Rail.Navigation.ActiveService, fx.Section)
        assert.equal(fx.Section.Current, wizard)
        assert.equal(fx.Content, wizard)
        assert.equal(wizard.StepIndex, ProvisionStep.Bootstrap)
        assert.equal(wizard.OwnerPassword, fx.Api.OwnerPassword)
        assert.equal(wizard.AgentToken, fx.Api.AgentToken)
    })

    it('a cross-section open of a hive while the provision is in flight keeps the wizard, which then reveals both values', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.AtReview()
        fx.Api.HoldCreates()
        wizard.SubmitCommand.Execute()
        await Tick.Settle()
        assert.equal(wizard.IsSubmitting, true)
        assert.equal(wizard.HasPendingSecret, true)
        assert.equal(fx.Section.BackCommand.CanExecute(), false)
        fx.Rail.Select(TenantsSectionService)
        await Tick.Settle()
        const tenants = fx.Content
        assert.ok(tenants instanceof TenantsPageViewModel)
        tenants.OpenCommand.Execute(tenants.Rows.ToArray().find(r => r.Id === 'acme-prod'))
        await Tick.Settle()
        const tenant = fx.Content
        assert.ok(tenant instanceof TenantDetailPageViewModel)
        tenant.OpenHiveCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Section.Current, wizard)
        fx.Api.Release()
        await Tick.Settle()
        assert.equal(fx.Rail.Navigation.ActiveService, fx.Section)
        assert.equal(fx.Section.Current, wizard)
        assert.equal(fx.Content, wizard)
        assert.equal(wizard.StepIndex, ProvisionStep.Bootstrap)
        assert.equal(wizard.OwnerPassword, fx.Api.OwnerPassword)
        assert.equal(wizard.AgentToken, fx.Api.AgentToken)
    })

    it('raises HasPendingSecret when a provision starts, and again when it fails', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.AtReview()
        const seen: Array<[unknown, unknown]> = []
        wizard.PropertyChanged(PendingSecret.ChangedProperty).subscribe(e => seen.push([e.oldValue, e.newValue]))
        fx.Api.Failure = new Error('refused')
        wizard.SubmitCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(seen, [[false, true], [true, false]])
        assert.equal(wizard.HasPendingSecret, false)
    })

    it('a cross-section open of a hive keeps a half-filled wizard and lands on it', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.Wizard()
        wizard.ClientId = 'initech'
        assert.equal(wizard.HasPendingWork, true)
        fx.Rail.Select(TenantsSectionService)
        await Tick.Settle()
        const tenants = fx.Content
        assert.ok(tenants instanceof TenantsPageViewModel)
        tenants.OpenCommand.Execute(tenants.Rows.ToArray().find(r => r.Id === 'acme-prod'))
        await Tick.Settle()
        const tenant = fx.Content
        assert.ok(tenant instanceof TenantDetailPageViewModel)
        tenant.OpenHiveCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Rail.Navigation.ActiveService, fx.Section)
        assert.equal(fx.Section.Current, wizard)
        assert.equal(fx.Content, wizard)
        assert.equal(wizard.ClientId, 'initech')
    })

    it('a cross-section open of a hive replaces an untouched wizard', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.Wizard()
        assert.equal(wizard.HasPendingWork, false)
        fx.Section.ShowHive('acme-hive')
        await Tick.Settle()
        assert.ok(fx.Content instanceof HiveDetailPageViewModel)
    })

    it('Finish clears both values and presents the new hive; Back then shows a fresh list', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.Revealed()
        wizard.OwnerSaved = true
        wizard.AgentSaved = true
        wizard.FinishCommand.Execute()
        await Tick.Settle()
        assert.equal(wizard.OwnerPassword, '')
        assert.equal(wizard.AgentToken, '')
        assert.equal(wizard.HasPendingSecret, false)
        // Everything reachable from the wizard and from its section, short of
        // the fake control plane itself (which keeps the fixture's values).
        const reachable = Inspect.ReachableStrings(wizard, [fx.Api])
        assert.equal(Inspect.ReachableStrings(fx.Section, [fx.Api]).some(v => v === fx.Api.AgentToken || v === fx.Api.OwnerPassword), false)
        assert.ok(reachable.includes('initech-hive'))
        assert.equal(reachable.includes(fx.Api.OwnerPassword), false)
        assert.equal(reachable.includes(fx.Api.AgentToken), false)
        const detail = fx.Content
        assert.ok(detail instanceof HiveDetailPageViewModel)
        assert.equal(fx.Section.Current, detail)
        assert.equal(detail.Id, 'initech-hive')
        detail.BackCommand.Execute()
        await Tick.Settle()
        const list = fx.Content
        assert.ok(list instanceof HivesPageViewModel)
        assert.deepEqual(list.Rows.ToArray().map(r => r.Id).sort(), ['acme-hive', 'initech-hive'])
        assert.equal(fx.Section.BackCommand.CanExecute(), false)
    })

    it('a provision error keeps the operator on Review with ErrorText set and no value revealed', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.AtReview()
        fx.Api.Failure = new ApiError(409, 'client initech already exists', { rolledBack: ['tenant initech-prod'], residue: ['hive initech-hive'] })
        wizard.SubmitCommand.Execute()
        await Tick.Settle()
        assert.equal(wizard.StepIndex, ProvisionStep.Review)
        assert.match(wizard.ErrorText, /client initech already exists/)
        assert.match(wizard.ErrorText, /Rolled back: tenant initech-prod/)
        assert.match(wizard.ErrorText, /hive initech-hive/)
        assert.equal(wizard.OwnerPassword, '')
        assert.equal(wizard.AgentToken, '')
        assert.equal(wizard.SubmitCommand.CanExecute(), true)
        fx.Api.Failure = undefined
        wizard.SubmitCommand.Execute()
        await Tick.Settle()
        assert.equal(wizard.ErrorText, '')
        assert.equal(wizard.StepIndex, ProvisionStep.Bootstrap)
    })

    it('a 401 from Provision expires the session', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.AtReview()
        fx.Api.Failure = new ApiError(ApiError.UnauthorizedStatus, 'unauthorized')
        wizard.SubmitCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Host.Reloader.Count, 1)
    })

    it('leaving through the rail before Finish keeps the wizard and its reveal as the current page', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.Revealed()
        fx.Rail.Select(TenantsSectionService)
        await Tick.Settle()
        assert.ok(fx.Content instanceof TenantsPageViewModel)
        fx.Rail.Select(HivesSectionService)
        assert.equal(fx.Content, wizard)
        assert.equal(wizard.StepIndex, ProvisionStep.Bootstrap)
        assert.equal(wizard.OwnerPassword, fx.Api.OwnerPassword)
        assert.equal(wizard.AgentToken, fx.Api.AgentToken)
    })

    it('a live-update refresh keeps the wizard on its step with its values', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.Revealed()
        await fx.Section.RefreshCurrent()
        assert.equal(fx.Content, wizard)
        assert.equal(wizard.StepIndex, ProvisionStep.Bootstrap)
        assert.equal(wizard.AgentToken, fx.Api.AgentToken)
    })

    it('the client and tenant choices list New first, then the existing records; tenants follow the client', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.Wizard()
        assert.deepEqual(wizard.Clients.ToArray().map(o => o.Label), ['New client', 'Acme'])
        assert.equal(wizard.IsNewClient, true)
        assert.deepEqual(wizard.Tenants.ToArray().map(o => o.Label), ['New tenant'])
        wizard.SelectedClient = wizard.Clients.Get(1)
        assert.equal(wizard.IsNewClient, false)
        assert.equal(wizard.NextCommand.CanExecute(), true)
        assert.deepEqual(wizard.Tenants.ToArray().map(o => o.Label), ['New tenant', 'Acme Production'])
        assert.equal(wizard.IsNewTenant, true)
        wizard.SelectedTenant = wizard.Tenants.Get(1)
        assert.equal(wizard.IsNewTenant, false)
        wizard.SelectedClient = wizard.Clients.Get(0)
        assert.deepEqual(wizard.Tenants.ToArray().map(o => o.Label), ['New tenant'])
        assert.equal(wizard.IsNewTenant, true)
        assert.equal(wizard.NextCommand.CanExecute(), false)
    })

    it('an existing client and tenant: the hive is provisioned onto them and only the agent token is revealed', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.Wizard()
        wizard.SelectedClient = wizard.Clients.Get(1)
        wizard.NextCommand.Execute()
        wizard.SelectedTenant = wizard.Tenants.Get(1)
        assert.equal(wizard.NextCommand.CanExecute(), true)
        wizard.NextCommand.Execute()
        wizard.HiveId = 'acme-hive-2'
        wizard.HiveDisplayName = 'Acme hive 2'
        wizard.NextCommand.Execute()
        assert.equal(wizard.ReviewCaption, 'Standing up creates the hive record for the existing tenant and a one-time bootstrap.')
        assert.deepEqual([wizard.ReviewClientCaption, wizard.ReviewClientName, wizard.ReviewClientId], ['Client (existing)', 'Acme', 'acme'])
        assert.deepEqual([wizard.ReviewTenantCaption, wizard.ReviewTenantName, wizard.ReviewTenantId, wizard.ReviewOwnerEmail], ['Tenant (existing)', 'Acme Production', 'acme-prod', ''])
        wizard.SubmitCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Provisioned[0].client, { existing: true, id: 'acme' })
        assert.deepEqual(fx.Api.Provisioned[0].tenant, { existing: true, id: 'acme-prod' })
        assert.equal(wizard.StepIndex, ProvisionStep.Bootstrap)
        assert.equal(wizard.RevealsOwner, false)
        assert.equal(wizard.OwnerPassword, '')
        assert.equal(wizard.FinishCommand.CanExecute(), false)
        wizard.AgentSaved = true
        assert.equal(wizard.FinishCommand.CanExecute(), true)
    })

    it('an existing client with a new tenant: the tenant and its Owner are created under it', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.Wizard()
        wizard.SelectedClient = wizard.Clients.Get(1)
        wizard.NextCommand.Execute()
        wizard.TenantId = 'acme-test'
        wizard.TenantDisplayName = 'Acme Test'
        wizard.OwnerEmail = 'owner@acme.test'
        wizard.NextCommand.Execute()
        wizard.HiveId = 'acme-test-hive'
        wizard.HiveDisplayName = 'Acme test hive'
        wizard.NextCommand.Execute()
        assert.equal(wizard.ReviewCaption, 'Standing up creates the tenant with its first Owner under the existing client, the hive record and a one-time bootstrap.')
        assert.equal(wizard.ReviewOwnerEmail, 'owner@acme.test')
        wizard.SubmitCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Provisioned[0].client, { existing: true, id: 'acme' })
        assert.deepEqual(fx.Api.Provisioned[0].tenant, { id: 'acme-test', displayName: 'Acme Test', ownerEmail: 'owner@acme.test' })
        assert.equal(wizard.RevealsOwner, true)
        assert.equal(wizard.OwnerPassword, fx.Api.OwnerPassword)
        wizard.AgentSaved = true
        assert.equal(wizard.FinishCommand.CanExecute(), false)
        wizard.OwnerSaved = true
        assert.equal(wizard.FinishCommand.CanExecute(), true)
    })

    it('a chosen existing client counts as pending work, and a refresh keeps the very choice', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.Wizard()
        assert.equal(wizard.HasPendingWork, false)
        const acme = wizard.Clients.Get(1)
        wizard.SelectedClient = acme
        const prod = wizard.Tenants.Get(1)
        wizard.SelectedTenant = prod
        assert.equal(wizard.HasPendingWork, true)
        await fx.Section.RefreshCurrent()
        assert.equal(wizard.SelectedClient, acme)
        assert.equal(wizard.SelectedTenant, prod)
        assert.equal(wizard.Clients.Get(1), acme)
    })

    it('Cancel returns to the hives list before anything is provisioned', async () =>
    {
        const fx = new WizardFixture()
        const wizard = await fx.Wizard()
        wizard.ClientId = 'initech'
        assert.equal(wizard.CancelCommand.CanExecute(), true)
        wizard.CancelCommand.Execute()
        await Tick.Settle()
        assert.ok(fx.Content instanceof HivesPageViewModel)
        assert.equal(fx.Api.ProvisionCalls, 0)
    })

    it('Observer: Stand up a hive and Submit are disabled and never provision', async () =>
    {
        const fx = new WizardFixture(OperatorContext.ReadOnlyWireRole)
        const list = await fx.List()
        assert.equal(list.StandUpCommand.CanExecute(), false)
        list.StandUpCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Content, list)
        const wizard = new ProvisionWizardPageViewModel(fx.Host.Session, fx.Section)
        assert.notEqual(wizard.DeniedReason, '')
        wizard.ClientId = 'initech'
        wizard.ClientDisplayName = 'Initech'
        wizard.NextCommand.Execute()
        wizard.TenantId = 'initech-prod'
        wizard.TenantDisplayName = 'Initech Production'
        wizard.OwnerEmail = 'owner@initech.test'
        wizard.NextCommand.Execute()
        wizard.HiveId = 'initech-hive'
        wizard.HiveDisplayName = 'Initech hive'
        wizard.NextCommand.Execute()
        assert.equal(wizard.StepIndex, ProvisionStep.Review)
        assert.equal(wizard.SubmitCommand.CanExecute(), false)
        wizard.SubmitCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Api.ProvisionCalls, 0)
    })
})
