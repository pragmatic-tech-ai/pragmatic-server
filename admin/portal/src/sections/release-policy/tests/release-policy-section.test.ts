import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OperatorContext } from '../../../operator-context.js'
import { PageState } from '../../../shell/portal-page-view-model.js'
import { FakeControlPlane, PortalTestHost, TestRail, Tick, type FakeDialogService } from '../../../shell/tests/portal-test-fixtures.js'
import { HiveDetailPageViewModel } from '../../hives/hive-detail-page-view-model.js'
import { HivesSectionService } from '../../hives/hives-section-service.js'
import { GateDialogViewModel } from '../gate-dialog-view-model.js'
import { PolicyEditDialogViewModel } from '../policy-edit-dialog-view-model.js'
import { ReleasePolicyPageViewModel } from '../release-policy-page-view-model.js'
import { ReleasePolicySectionService } from '../release-policy-section-service.js'

// Release Policy (and Hives, for the ledger's hive links) behind a real rail.
class PolicyFixture
{
    public readonly Api: FakeControlPlane
    public readonly Host: PortalTestHost
    public readonly Dialogs: FakeDialogService
    public readonly Rail: TestRail

    public constructor(wireRole: string = OperatorContext.FullWireRole)
    {
        this.Api = new FakeControlPlane()
            .WithClient('acme', 'Acme')
            .WithTenant('acme-prod', 'acme', 'Acme Production')
            .WithHive('acme-hive', 'acme-prod')
            .WithTenant('acme-dev', 'acme', 'Acme Dev')
            .WithManifest('1.4.0', 'img:0')
            .WithManifest('1.3.0', 'img:old', { withdrawn: true })
        this.Api.Policies = [{ tenantId: 'acme-prod', channels: ['stable'], minVersion: '1.2.0' }]
        this.Api.Gating = [
            { tenantId: 'acme-prod', version: '1.4.0', gatedAt: '2026-10-15T00:00:00.000Z' },
            { tenantId: 'acme-prod', version: '1.3.0', gatedAt: '2026-10-02T00:00:00.000Z' },
        ]
        this.Api.Ledger = [
            { id: 'l1', hiveId: 'acme-hive', tenantId: 'acme-prod', version: '1.3.0', action: 'adopted', at: '2026-10-03T00:00:00.000Z' },
            { id: 'l2', hiveId: 'acme-hive', tenantId: 'acme-prod', version: '1.4.0', action: 'selected', at: '2026-10-16T00:00:00.000Z' },
        ]
        this.Host = new PortalTestHost(this.Api.AsClient(), wireRole)
        this.Dialogs = this.Host.UseDialogs()
        this.Host.Provider.register(ReleasePolicySectionService.Key, (p) => new ReleasePolicySectionService(p))
        this.Host.Provider.register(HivesSectionService.Key, (p) => new HivesSectionService(p))
        this.Rail = new TestRail(this.Host.Provider)
        this.Rail.Add(ReleasePolicySectionService)
        this.Rail.Add(HivesSectionService)
    }

    public get Content(): unknown
    {
        return this.Host.Host.Content
    }

    public async Page(): Promise<ReleasePolicyPageViewModel>
    {
        this.Rail.Select(ReleasePolicySectionService)
        await Tick.Settle()
        assert.ok(this.Content instanceof ReleasePolicyPageViewModel)
        return this.Content
    }
}

describe('Release Policy section', () =>
{
    it('shows each tenant and hive policy, with inherited and unset values labelled', async () =>
    {
        const fx = new PolicyFixture()
        const page = await fx.Page()
        assert.equal(page.State, PageState.Populated)
        assert.deepEqual(page.PolicyRows.ToArray().map(r => [r.AppliesToLabel, r.ScopeLabel, r.ChannelsLabel, r.MinVersionLabel, r.HoldLabel]), [
            ['Acme / Acme Dev', 'Every hive of this tenant', 'All channels', 'No minimum', 'None'],
            ['Acme / Acme Production', 'Every hive of this tenant', 'Stable', '1.2.0', 'None'],
            ['Hive acme-hive', 'One hive', 'Inherits tenant', 'Inherits tenant', 'None'],
        ])
    })

    it('gated versions show their tenant and why a gated version is blocked', async () =>
    {
        const fx = new PolicyFixture()
        const page = await fx.Page()
        assert.deepEqual(page.GatedRows.ToArray().map(r => [r.OwnerLabel, r.Version, r.GatedLabel, r.BlockedLabel]), [
            ['Acme / Acme Production', '1.3.0', '2026-10-02', 'Blocked: withdrawn'],
            ['Acme / Acme Production', '1.4.0', '2026-10-15', 'Adoptable'],
        ])
    })

    it('the adoption ledger loads every hive entry, newest first', async () =>
    {
        const fx = new PolicyFixture()
        const page = await fx.Page()
        assert.equal(page.HasLedger, true)
        assert.deepEqual(page.LedgerRows.ToArray().map(r => [r.WhenLabel, r.HiveLabel, r.ActionLabel, r.Version]), [
            ['2026-10-16', 'Hive acme-hive', 'Selected as target', '1.4.0'],
            ['2026-10-03', 'Hive acme-hive', 'Adopted', '1.3.0'],
        ])
    })

    it('a ledger row opens its hive in Hives', async () =>
    {
        const fx = new PolicyFixture()
        const page = await fx.Page()
        page.LedgerRows.Get(0)?.OpenHiveCommand.Execute()
        await Tick.Settle()
        assert.ok(fx.Content instanceof HiveDetailPageViewModel)
        assert.equal(fx.Content.Id, 'acme-hive')
    })

    it('Edit a tenant policy saves only what changed through the tenant policy methods', async () =>
    {
        const fx = new PolicyFixture()
        const page = await fx.Page()
        page.PolicyRows.Get(1)?.EditCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last
        assert.ok(dialog instanceof PolicyEditDialogViewModel)
        assert.equal(dialog.Stable, true)
        assert.equal(dialog.EarlyAccess, false)
        assert.equal(dialog.MinVersion, '1.2.0')
        assert.equal(dialog.IsHeld, false)
        dialog.EarlyAccess = true
        dialog.MinVersion = ''
        dialog.IsHeld = true
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.HoldReason = 'Change freeze'
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.PolicyCalls, [
            'SetTenantChannels acme-prod stable,early',
            'ClearTenantMinVersion acme-prod',
            'SetTenantHold acme-prod Change freeze',
        ])
        assert.equal(fx.Dialogs.IsOpen, false)
        const row = page.PolicyRows.Get(1)
        assert.equal(row?.ChannelsLabel, 'Stable, Early access')
        assert.equal(row?.HoldLabel, 'Held: Change freeze')
    })

    it('Edit a hive policy saves through the hive policy methods', async () =>
    {
        const fx = new PolicyFixture()
        const page = await fx.Page()
        page.PolicyRows.Get(2)?.EditCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last as PolicyEditDialogViewModel
        dialog.MinVersion = '1.4.0'
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.PolicyCalls, ['SetHiveMinVersion acme-hive 1.4.0'])
        assert.equal(page.PolicyRows.Get(2)?.MinVersionLabel, '1.4.0')
    })

    it('releasing a hold clears it', async () =>
    {
        const fx = new PolicyFixture()
        fx.Api.Policies[0].hold = { reason: 'Freeze', actor: 'op', at: '2026-10-22T00:00:00.000Z' }
        const page = await fx.Page()
        page.PolicyRows.Get(1)?.EditCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last as PolicyEditDialogViewModel
        assert.equal(dialog.IsHeld, true)
        assert.equal(dialog.HoldReason, 'Freeze')
        dialog.IsHeld = false
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.PolicyCalls, ['ClearTenantHold acme-prod'])
    })

    it('Gate a version through a dialog, and Ungate a gated row', async () =>
    {
        const fx = new PolicyFixture()
        const page = await fx.Page()
        page.GateCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last
        assert.ok(dialog instanceof GateDialogViewModel)
        assert.deepEqual(dialog.Tenants.ToArray().map(t => t.Value), ['acme-dev', 'acme-prod'])
        assert.deepEqual(dialog.Versions.ToArray().map(v => v.Value), ['1.4.0'])
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.SelectedTenant = dialog.Tenants.Get(0)
        dialog.SelectedVersion = dialog.Versions.Get(0)
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.GateCalls, [['acme-dev', '1.4.0']])
        assert.equal(page.GatedRows.Count, 3)
        page.GatedRows.Get(0)?.UngateCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.UngateCalls, [['acme-dev', '1.4.0']])
        assert.equal(page.GatedRows.Count, 2)
    })

    it('the Gate dialog offers only versions not yet gated for the chosen tenant', async () =>
    {
        const fx = new PolicyFixture()
        fx.Api.WithManifest('1.5.0', 'img:new')
        const page = await fx.Page()
        page.GateCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last as GateDialogViewModel
        dialog.SelectedTenant = dialog.Tenants.ToArray().find(t => t.Value === 'acme-prod')
        assert.deepEqual(dialog.Versions.ToArray().map(v => v.Value), ['1.5.0'])
        dialog.SelectedTenant = dialog.Tenants.ToArray().find(t => t.Value === 'acme-dev')
        assert.deepEqual(dialog.Versions.ToArray().map(v => v.Value), ['1.5.0', '1.4.0'])
    })

    it('changing tenant keeps the chosen version selected from the new list when still offered, else clears it', async () =>
    {
        const fx = new PolicyFixture()
        fx.Api.WithManifest('1.5.0', 'img:new')
        const page = await fx.Page()
        page.GateCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last as GateDialogViewModel
        dialog.SelectedTenant = dialog.Tenants.ToArray().find(t => t.Value === 'acme-dev')
        dialog.SelectedVersion = dialog.Versions.ToArray().find(v => v.Value === '1.5.0')
        dialog.SelectedTenant = dialog.Tenants.ToArray().find(t => t.Value === 'acme-prod')
        assert.equal(dialog.SelectedVersion?.Value, '1.5.0')
        assert.ok(dialog.Versions.ToArray().includes(dialog.SelectedVersion))
        dialog.SelectedTenant = dialog.Tenants.ToArray().find(t => t.Value === 'acme-dev')
        dialog.SelectedVersion = dialog.Versions.ToArray().find(v => v.Value === '1.4.0')
        dialog.SelectedTenant = dialog.Tenants.ToArray().find(t => t.Value === 'acme-prod')
        assert.equal(dialog.SelectedVersion, undefined)
    })

    it('a partly failed policy save keeps what was written, so a retry does not resend it', async () =>
    {
        const fx = new PolicyFixture()
        const page = await fx.Page()
        page.PolicyRows.Get(1)?.EditCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last as PolicyEditDialogViewModel
        dialog.EarlyAccess = true
        dialog.MinVersion = '1.3.0'
        fx.Api.FailPolicyCall = 'SetTenantMinVersion'
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Dialogs.IsOpen, true)
        assert.match(dialog.ErrorText, /refused/)
        assert.deepEqual(fx.Api.PolicyCalls, ['SetTenantChannels acme-prod stable,early'])
        fx.Api.FailPolicyCall = undefined
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.PolicyCalls, ['SetTenantChannels acme-prod stable,early', 'SetTenantMinVersion acme-prod 1.3.0'])
        assert.equal(fx.Dialogs.IsOpen, false)
    })

    it('Selected targets: each hive target version with its owner and when it was selected', async () =>
    {
        const fx = new PolicyFixture()
        fx.Api.Selections = [{ hiveId: 'acme-hive', targetVersion: '1.4.0', selectedAt: '2026-10-16T00:00:00.000Z' }]
        const page = await fx.Page()
        assert.equal(page.HasTargets, true)
        assert.deepEqual(page.TargetRows.ToArray().map(r => [r.HiveLabel, r.OwnerLabel, r.TargetVersion, r.SelectedLabel]), [
            ['Hive acme-hive', 'Acme / Acme Production', '1.4.0', '2026-10-16'],
        ])
    })

    it('Rollout status: every hive environment against its target', async () =>
    {
        const fx = new PolicyFixture()
        fx.Api.Rollouts = [{ hiveId: 'acme-hive', targetVersion: '1.4.0', environments: [
            { environmentName: 'prod', runningImage: 'img:0', obsolete: false, ready: true },
            { environmentName: 'dev', runningImage: 'img:old', obsolete: true, ready: true },
            { environmentName: 'qa', obsolete: false, ready: false },
        ] }]
        const page = await fx.Page()
        assert.equal(page.HasRollouts, true)
        assert.deepEqual(page.RolloutRows.ToArray().map(r => [r.HiveLabel, r.OwnerLabel, r.Environment, r.TargetLabel, r.RunningLabel, r.StatusLabel]), [
            ['Hive acme-hive', 'Acme / Acme Production', 'dev', '1.4.0', 'img:old', 'Behind target'],
            ['Hive acme-hive', 'Acme / Acme Production', 'prod', '1.4.0', 'img:0', 'On target'],
            ['Hive acme-hive', 'Acme / Acme Production', 'qa', '1.4.0', 'Not reported', 'Not ready'],
        ])
    })

    it('no targets or rollouts -> their empty notes', async () =>
    {
        const fx = new PolicyFixture()
        const page = await fx.Page()
        assert.equal(page.HasNoTargets, true)
        assert.equal(page.HasNoRollouts, true)
    })

    it('nothing to show -> Empty', async () =>
    {
        const fx = new PolicyFixture()
        fx.Api.Tenants = []
        fx.Api.Hives = []
        fx.Api.Gating = []
        fx.Api.Ledger = []
        const page = await fx.Page()
        assert.equal(page.State, PageState.Empty)
    })

    it('Observer: Edit policy, Gate and Ungate are disabled and never open a dialog', async () =>
    {
        const fx = new PolicyFixture(OperatorContext.ReadOnlyWireRole)
        const page = await fx.Page()
        assert.equal(page.GateCommand.CanExecute(), false)
        assert.notEqual(page.DeniedReason, '')
        page.GateCommand.Execute()
        for (const row of page.PolicyRows.ToArray())
        {
            assert.equal(row.EditCommand.CanExecute(), false)
            row.EditCommand.Execute()
        }
        for (const row of page.GatedRows.ToArray())
        {
            assert.equal(row.UngateCommand.CanExecute(), false)
            row.UngateCommand.Execute()
        }
        await Tick.Settle()
        assert.equal(fx.Dialogs.Shown.length, 0)
        assert.deepEqual(fx.Api.PolicyCalls, [])
        assert.deepEqual(fx.Api.UngateCalls, [])
    })
})
