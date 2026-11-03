import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../../../api-client.js'
import { OperatorContext } from '../../../operator-context.js'
import { NameConfirmDialogViewModel } from '../../../shell/name-confirm-dialog-view-model.js'
import { FakeControlPlane, PortalTestHost, Tick, type FakeDialogService } from '../../../shell/tests/portal-test-fixtures.js'
import { HiveDetailPageViewModel } from '../hive-detail-page-view-model.js'
import { HivesPageViewModel } from '../hives-page-view-model.js'
import { HivesSectionService } from '../hives-section-service.js'

// The Hives section over a fake control plane whose hive delete can fail on the agent's removal.
class DeleteFixture
{
    public static readonly UninstallFailure = "Could not remove the hive's agent from its cluster: kubectl failed: connection refused. Fix cluster access and retry, or delete anyway to remove only the platform record."
    public readonly Api: FakeControlPlane
    public readonly Host: PortalTestHost
    public readonly Dialogs: FakeDialogService
    public readonly Section: HivesSectionService

    public constructor(wireRole: string = OperatorContext.FullWireRole)
    {
        this.Api = new FakeControlPlane()
            .WithClient('acme', 'Acme')
            .WithTenant('acme-prod', 'acme', 'Acme Production')
            .WithHive('acme-hive', 'acme-prod')
        this.Host = new PortalTestHost(this.Api.AsClient(), wireRole)
        this.Dialogs = this.Host.UseDialogs()
        this.Section = new HivesSectionService(this.Host.Provider)
    }

    public get Content(): unknown
    {
        return this.Host.Host.Content
    }

    public async Detail(): Promise<HiveDetailPageViewModel>
    {
        this.Section.OnActivated()
        await Tick.Settle()
        assert.ok(this.Content instanceof HivesPageViewModel)
        this.Content.Rows.Get(0)?.OpenCommand.Execute()
        await Tick.Settle()
        assert.ok(this.Content instanceof HiveDetailPageViewModel)
        return this.Content
    }

    // Runs a command that opens a name-confirm dialog, types the hive id and confirms; returns the dialog.
    public async Confirm(run: () => void): Promise<NameConfirmDialogViewModel>
    {
        run()
        await Tick.Settle()
        const confirm = this.Dialogs.Last
        assert.ok(confirm instanceof NameConfirmDialogViewModel)
        confirm.Typed = 'acme-hive'
        confirm.ConfirmCommand.Execute()
        await Tick.Settle()
        return confirm
    }
}

describe('Hive delete: the agent cannot be removed from its cluster', () =>
{
    it('the failure shows in the dialog and the page then offers Delete anyway with the reason', async () =>
    {
        const fx = new DeleteFixture()
        fx.Api.DeleteHiveFailure = new ApiError(409, DeleteFixture.UninstallFailure, undefined, ApiError.AgentUninstallFailedCode)
        const detail = await fx.Detail()
        assert.equal(detail.CanDeleteAnyway, false)
        assert.equal(detail.DeleteAnywayCommand.CanExecute(), false)
        const confirm = await fx.Confirm(() => detail.DeleteCommand.Execute())
        assert.equal(confirm.ErrorText, DeleteFixture.UninstallFailure)
        assert.deepEqual(fx.Api.Deleted, [])
        fx.Dialogs.Dismiss()
        await Tick.Settle()
        assert.equal(fx.Content, detail)
        assert.equal(detail.CanDeleteAnyway, true)
        assert.equal(detail.DeleteAnywayText, DeleteFixture.UninstallFailure)
        assert.equal(detail.DeleteAnywayCommand.CanExecute(), true)
    })

    it('Delete anyway confirms by name, warns the agent may remain locked out, force-deletes and returns to the list', async () =>
    {
        const fx = new DeleteFixture()
        fx.Api.DeleteHiveFailure = new ApiError(409, DeleteFixture.UninstallFailure, undefined, ApiError.AgentUninstallFailedCode)
        const detail = await fx.Detail()
        await fx.Confirm(() => detail.DeleteCommand.Execute())
        fx.Dialogs.Dismiss()
        await Tick.Settle()
        const anyway = await fx.Confirm(() => detail.DeleteAnywayCommand.Execute())
        assert.match(anyway.Message, /may remain in the cluster/)
        assert.match(anyway.Message, /locked out/)
        assert.equal(anyway.ConfirmLabel, 'Delete anyway')
        assert.deepEqual(fx.Api.ForcedDeletes, ['acme-hive'])
        assert.deepEqual(fx.Api.Deleted, ['acme-hive'])
        assert.ok(fx.Content instanceof HivesPageViewModel)
    })

    it('any other refusal (e.g. the hive still has environments) offers no Delete anyway', async () =>
    {
        const fx = new DeleteFixture()
        fx.Api.DeleteHiveFailure = new ApiError(409, 'Hive acme-hive still has environments')
        const detail = await fx.Detail()
        const confirm = await fx.Confirm(() => detail.DeleteCommand.Execute())
        assert.equal(confirm.ErrorText, 'Hive acme-hive still has environments')
        fx.Dialogs.Dismiss()
        await Tick.Settle()
        assert.equal(detail.CanDeleteAnyway, false)
        assert.equal(detail.DeleteAnywayCommand.CanExecute(), false)
    })

    it('a later successful delete needs no Delete anyway (a retry after the cluster is fixed)', async () =>
    {
        const fx = new DeleteFixture()
        fx.Api.DeleteHiveFailure = new ApiError(409, DeleteFixture.UninstallFailure, undefined, ApiError.AgentUninstallFailedCode)
        const detail = await fx.Detail()
        await fx.Confirm(() => detail.DeleteCommand.Execute())
        fx.Dialogs.Dismiss()
        await Tick.Settle()
        fx.Api.DeleteHiveFailure = undefined
        await fx.Confirm(() => detail.DeleteCommand.Execute())
        assert.deepEqual(fx.Api.Deleted, ['acme-hive'])
        assert.deepEqual(fx.Api.ForcedDeletes, [])
        assert.ok(fx.Content instanceof HivesPageViewModel)
    })

    it('a kind cluster that cannot be destroyed also offers Delete anyway, warning the cluster may be left behind', async () =>
    {
        const fx = new DeleteFixture()
        fx.Api.DeleteHiveFailure = new ApiError(409, "Could not destroy the hive's kind cluster: kind failed: docker down.", undefined, ApiError.ClusterDestroyFailedCode)
        const detail = await fx.Detail()
        await fx.Confirm(() => detail.DeleteCommand.Execute())
        fx.Dialogs.Dismiss()
        await Tick.Settle()
        assert.equal(detail.CanDeleteAnyway, true)
        const anyway = await fx.Confirm(() => detail.DeleteAnywayCommand.Execute())
        assert.match(anyway.Message, /kind cluster may be left behind/)
        assert.deepEqual(fx.Api.ForcedDeletes, ['acme-hive'])
    })

    it('a later delete failure for another reason withdraws Delete anyway, and so does a reload', async () =>
    {
        const fx = new DeleteFixture()
        fx.Api.DeleteHiveFailure = new ApiError(409, DeleteFixture.UninstallFailure, undefined, ApiError.AgentUninstallFailedCode)
        const detail = await fx.Detail()
        await fx.Confirm(() => detail.DeleteCommand.Execute())
        fx.Dialogs.Dismiss()
        await Tick.Settle()
        assert.equal(detail.CanDeleteAnyway, true)
        fx.Api.DeleteHiveFailure = new ApiError(409, 'Hive acme-hive still has environments')
        await fx.Confirm(() => detail.DeleteCommand.Execute())
        fx.Dialogs.Dismiss()
        await Tick.Settle()
        assert.equal(detail.CanDeleteAnyway, false)
        assert.equal(detail.DeleteAnywayText, '')
        fx.Api.DeleteHiveFailure = new ApiError(409, DeleteFixture.UninstallFailure, undefined, ApiError.AgentUninstallFailedCode)
        await fx.Confirm(() => detail.DeleteCommand.Execute())
        fx.Dialogs.Dismiss()
        await Tick.Settle()
        assert.equal(detail.CanDeleteAnyway, true)
        await detail.Refresh()
        assert.equal(detail.CanDeleteAnyway, false)
        assert.equal(detail.DeleteAnywayCommand.CanExecute(), false)
    })

    it('the Delete dialog says the agent is removed and its token revoked, and that the data volume is kept', async () =>
    {
        const fx = new DeleteFixture()
        const detail = await fx.Detail()
        detail.DeleteCommand.Execute()
        await Tick.Settle()
        const confirm = fx.Dialogs.Last
        assert.ok(confirm instanceof NameConfirmDialogViewModel)
        assert.match(confirm.Message, /agent is removed from its cluster/)
        assert.match(confirm.Message, /token is revoked/)
        assert.match(confirm.Message, /kind cluster is destroyed/)
        assert.match(confirm.Message, /data volume and its seed Secret are kept/)
    })

    it('after a delete the hives list says what was kept, and what a delete anyway may have left', async () =>
    {
        const fx = new DeleteFixture()
        fx.Api.DeleteOutcome = { ok: true, retained: ['pragmatic-tenant-admin-acme-prod-data', 'pragmatic-tenant-admin-acme-prod-seed'] }
        const detail = await fx.Detail()
        await fx.Confirm(() => detail.DeleteCommand.Execute())
        const list = fx.Content
        assert.ok(list instanceof HivesPageViewModel)
        assert.equal(list.HasNotice, true)
        assert.match(list.NoticeText, /^Hive acme-hive was deleted\./)
        assert.match(list.NoticeText, /pragmatic-tenant-admin-acme-prod-data, pragmatic-tenant-admin-acme-prod-seed/)
        list.DismissNoticeCommand.Execute()
        assert.equal(list.HasNotice, false)
        assert.equal(list.NoticeText, '')
    })

    it('a delete anyway notice reaches the list too', async () =>
    {
        const fx = new DeleteFixture()
        fx.Api.DeleteHiveFailure = new ApiError(409, DeleteFixture.UninstallFailure, undefined, ApiError.AgentUninstallFailedCode)
        fx.Api.DeleteOutcome = { ok: true, retained: [], notice: 'The agent was not removed: the agent may remain in the cluster, locked out.' }
        const detail = await fx.Detail()
        await fx.Confirm(() => detail.DeleteCommand.Execute())
        fx.Dialogs.Dismiss()
        await Tick.Settle()
        await fx.Confirm(() => detail.DeleteAnywayCommand.Execute())
        const list = fx.Content
        assert.ok(list instanceof HivesPageViewModel)
        assert.match(list.NoticeText, /agent may remain in the cluster, locked out/)
    })

    it('Observer: Delete anyway is disabled even after the failure is known', async () =>
    {
        const fx = new DeleteFixture(OperatorContext.ReadOnlyWireRole)
        const detail = await fx.Detail()
        assert.equal(detail.DeleteAnywayCommand.CanExecute(), false)
        detail.DeleteAnywayCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Dialogs.Shown.length, 0)
    })
})
