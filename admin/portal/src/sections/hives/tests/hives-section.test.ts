import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OperatorContext } from '../../../operator-context.js'
import { NameConfirmDialogViewModel } from '../../../shell/name-confirm-dialog-view-model.js'
import { PageState } from '../../../shell/portal-page-view-model.js'
import { FakeControlPlane, Inspect, PortalTestHost, Tick, type FakeDialogService } from '../../../shell/tests/portal-test-fixtures.js'
import { HiveDetailPageViewModel, HiveLedgerRowViewModel, LedgerAction } from '../hive-detail-page-view-model.js'
import { HivesPageViewModel } from '../hives-page-view-model.js'
import { HivesSectionService } from '../hives-section-service.js'
import { NewHiveDialogViewModel } from '../new-hive-dialog-view-model.js'
import { HiveOptions } from '../hive-options.js'

// A Hives section over a fake control plane and fake dialogs.
class HivesFixture
{
    public static readonly Secret = 'tok-should-never-surface'

    public readonly Api: FakeControlPlane
    public readonly Host: PortalTestHost
    public readonly Dialogs: FakeDialogService
    public readonly Section: HivesSectionService

    public constructor(wireRole: string = OperatorContext.FullWireRole)
    {
        this.Api = new FakeControlPlane()
            .WithClient('acme', 'Acme')
            .WithTenant('acme-prod', 'acme', 'Acme Production')
            .WithHive('acme-hive', 'acme-prod', [true, false], 'registry-pull/acme-hive')
            .WithTenant('acme-dev', 'acme', 'Acme Dev')
        this.Host = new PortalTestHost(this.Api.AsClient(), wireRole)
        this.Dialogs = this.Host.UseDialogs()
        this.Section = new HivesSectionService(this.Host.Provider)
    }

    public get Content(): unknown
    {
        return this.Host.Host.Content
    }

    public async List(): Promise<HivesPageViewModel>
    {
        this.Section.OnActivated()
        await Tick.Settle()
        assert.ok(this.Content instanceof HivesPageViewModel)
        return this.Content
    }

    public async Detail(): Promise<HiveDetailPageViewModel>
    {
        const list = await this.List()
        list.Rows.Get(0)?.OpenCommand.Execute()
        await Tick.Settle()
        assert.ok(this.Content instanceof HiveDetailPageViewModel)
        return this.Content
    }
}

describe('Hives section', () =>
{
    it('every ledger action has a readable label; an unknown wire action shows as sent', () =>
    {
        for (const action of Object.values(LedgerAction))
        {
            assert.notEqual(HiveLedgerRowViewModel.LabelFor(action), action)
        }
        assert.equal(HiveLedgerRowViewModel.LabelFor('constructor'), 'constructor')
    })

    it('the list loads each hive with its owner, connection and health', async () =>
    {
        const fx = new HivesFixture()
        const list = await fx.List()
        assert.equal(list.State, PageState.Populated)
        assert.equal(list.Rows.Count, 1)
        const row = list.Rows.Get(0)
        assert.equal(row?.DisplayName, 'Hive acme-hive')
        assert.equal(row?.OwnerLabel, 'Acme / Acme Production')
        assert.equal(row?.ClusterLabel, 'local / attach')
        assert.equal(row?.ConnectionLabel, 'Connected')
        assert.equal(row?.HealthLabel, '1 not ready')
        assert.equal(row?.EnvCountText, '2')
    })

    it('a row exposes its credential by name only, never a token value', async () =>
    {
        const fx = new HivesFixture()
        Object.assign(fx.Api.Hives[0], { agentToken: HivesFixture.Secret })
        Object.assign(fx.Api.Fleet[0], { agentToken: HivesFixture.Secret })
        const list = await fx.List()
        const row = list.Rows.Get(0) as object
        assert.equal((row as { CredentialLabel: string }).CredentialLabel, 'registry-pull/acme-hive')
        const reachable = Inspect.ReachableStrings(row)
        assert.ok(reachable.includes('registry-pull/acme-hive'))
        assert.equal(reachable.some(v => v.includes(HivesFixture.Secret)), false)
    })

    it('list -> detail: home channel, credentials by name and status, rollout, history, observed environments', async () =>
    {
        const fx = new HivesFixture()
        fx.Api.Rollouts = [{ hiveId: 'acme-hive', targetVersion: '1.4.0', environments: [
            { environmentName: 'env0', runningImage: 'img:0', obsolete: false, ready: true },
            { environmentName: 'env1', runningImage: 'img:old', obsolete: true, ready: true },
        ] }]
        fx.Api.Ledger = [{ id: 'l1', hiveId: 'acme-hive', version: '1.4.0', action: 'selected', at: '2026-10-20T00:00:00.000Z' }]
        fx.Api.Policies = [{ tenantId: 'acme-prod', hiveId: 'acme-hive', channels: ['stable'] }]
        const detail = await fx.Detail()
        assert.equal(detail.State, PageState.Populated)
        assert.equal(detail.Id, 'acme-hive')
        assert.equal(detail.OwnerLabel, 'Acme / Acme Production')
        assert.equal(detail.ConnectionLabel, 'Connected')
        assert.equal(detail.HasBanner, false)
        assert.deepEqual(detail.Credentials.ToArray().map(c => [c.Kind, c.Name, c.Status]), [
            ['Registry credential', 'registry-pull/acme-hive', 'Referenced by name'],
            ['Trust root', '-', 'Not set'],
            ['Cluster config', '-', 'Not set'],
        ])
        assert.equal(detail.TargetVersionLabel, '1.4.0')
        assert.deepEqual(detail.RolloutRows.ToArray().map(r => r.StateLabel), ['Up to date', 'Behind target'])
        assert.equal(detail.LedgerRows.Get(0)?.ActionLabel, 'Selected as target')
        assert.equal(detail.ChannelsLabel, 'stable')
        assert.equal(detail.MinVersionLabel, 'Inherits tenant')
        assert.equal(detail.Observed.Rows.Count, 2)
        assert.equal(Inspect.HasCommand(detail.Observed), false)
        detail.BackCommand.Execute()
        assert.ok(fx.Content instanceof HivesPageViewModel)
    })

    it('New hive refuses an id that is not a lowercase Kubernetes name (=b, "b ", upper case) and says why', async () =>
    {
        const fx = new HivesFixture()
        const list = await fx.List()
        list.NewCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last
        assert.ok(dialog instanceof NewHiveDialogViewModel)
        dialog.SelectedTenant = dialog.Tenants.Get(0)
        dialog.DisplayName = 'Acme Dev hive'
        assert.equal(dialog.IdHint, '')
        for (const id of ['=b', 'b c', 'Acme', '-b', 'a_b', 'a'.repeat(35)])
        {
            dialog.Id = id
            assert.equal(dialog.ConfirmCommand.CanExecute(), false, id)
            assert.match(dialog.IdHint, /lowercase/)
        }
        dialog.Id = 'a'.repeat(34)
        assert.equal(dialog.IdHint, '')
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        dialog.Id = 'acme-dev-hive'
        assert.equal(dialog.IdHint, '')
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
    })

    it('the portal caps hive ids where the control plane does (34: the kind cluster name), and says so', () =>
    {
        assert.equal(HiveOptions.IdMaxLength, 34)
        assert.equal(HiveOptions.IsValidId('a'.repeat(34)), true)
        assert.equal(HiveOptions.IsValidId('a'.repeat(35)), false)
        assert.match(HiveOptions.IdHintFor('a'.repeat(35)), /at most 34 characters/)
    })

    it('New hive goes through a dialog offering only tenants without a hive', async () =>
    {
        const fx = new HivesFixture()
        const list = await fx.List()
        list.NewCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last
        assert.ok(dialog instanceof NewHiveDialogViewModel)
        assert.deepEqual(dialog.Tenants.ToArray().map(t => t.Value), ['acme-dev'])
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.SelectedTenant = dialog.Tenants.Get(0)
        dialog.Id = 'acme-dev-hive'
        dialog.DisplayName = 'Acme Dev hive'
        dialog.CredentialRef = 'registry-pull/dev'
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.CreatedHives, [{
            id: 'acme-dev-hive', tenantId: 'acme-dev', displayName: 'Acme Dev hive',
            cluster: { backend: 'local', mode: 'attach' },
            registry: { mode: 'attach', credentialRef: 'registry-pull/dev' },
        }])
        assert.equal(fx.Dialogs.IsOpen, false)
        assert.equal(fx.Content, list)
        assert.deepEqual(list.Rows.ToArray().map(r => r.Id), ['acme-hive', 'acme-dev-hive'])
        assert.equal(list.Rows.Get(1)?.CredentialLabel, 'registry-pull/dev')
    })

    it('Delete asks for the hive id and, on a match, deletes and returns to the list', async () =>
    {
        const fx = new HivesFixture()
        const detail = await fx.Detail()
        detail.DeleteCommand.Execute()
        await Tick.Settle()
        const confirm = fx.Dialogs.Last
        assert.ok(confirm instanceof NameConfirmDialogViewModel)
        confirm.Typed = 'acme'
        assert.equal(confirm.ConfirmCommand.CanExecute(), false)
        confirm.Typed = 'acme-hive'
        confirm.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Deleted, ['acme-hive'])
        const list = fx.Content
        assert.ok(list instanceof HivesPageViewModel)
        assert.equal(list.State, PageState.Empty)
    })

    it('Stand up a hive is enabled for a Full operator', async () =>
    {
        const fx = new HivesFixture()
        const list = await fx.List()
        assert.equal(list.StandUpCommand.CanExecute(), true)
    })

    it('Observer: New, Stand up and Delete are disabled and never open a dialog', async () =>
    {
        const fx = new HivesFixture(OperatorContext.ReadOnlyWireRole)
        const list = await fx.List()
        assert.equal(list.NewCommand.CanExecute(), false)
        assert.equal(list.StandUpCommand.CanExecute(), false)
        list.NewCommand.Execute()
        const detail = await fx.Detail()
        assert.equal(detail.DeleteCommand.CanExecute(), false)
        detail.DeleteCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Dialogs.Shown.length, 0)
    })
})
