import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OperatorContext } from '../../../operator-context.js'
import { NameConfirmDialogViewModel } from '../../../shell/name-confirm-dialog-view-model.js'
import { PageState } from '../../../shell/portal-page-view-model.js'
import { FakeControlPlane, PortalTestHost, Tick, type FakeDialogService } from '../../../shell/tests/portal-test-fixtures.js'
import { PublishDialogViewModel } from '../publish-dialog-view-model.js'
import { ReleaseDetailPageViewModel } from '../release-detail-page-view-model.js'
import { ReleasesPageViewModel } from '../releases-page-view-model.js'
import { ReleasesSectionService } from '../releases-section-service.js'

// A Registry & Releases section over a fake control plane and fake dialogs.
class ReleasesFixture
{
    public readonly Api: FakeControlPlane
    public readonly Host: PortalTestHost
    public readonly Dialogs: FakeDialogService
    public readonly Section: ReleasesSectionService

    public constructor(wireRole: string = OperatorContext.FullWireRole)
    {
        this.Api = new FakeControlPlane()
            .WithClient('acme', 'Acme')
            .WithTenant('acme-prod', 'acme', 'Acme Production')
            .WithHive('acme-hive', 'acme-prod', [true, false])
            .WithManifest('1.4.0', 'img:0', { publishedAt: '2026-10-12T00:00:00.000Z', notes: 'Faster graphs', digest: 'sha256:abcdef0123456789abcdef' })
            .WithManifest('1.3.0', 'img:old', { publishedAt: '2026-10-01T00:00:00.000Z', channel: 'early', signed: false })
        this.Host = new PortalTestHost(this.Api.AsClient(), wireRole)
        this.Dialogs = this.Host.UseDialogs()
        this.Section = new ReleasesSectionService(this.Host.Provider)
    }

    public get Content(): unknown
    {
        return this.Host.Host.Content
    }

    public async List(): Promise<ReleasesPageViewModel>
    {
        this.Section.OnActivated()
        await Tick.Settle()
        assert.ok(this.Content instanceof ReleasesPageViewModel)
        return this.Content
    }

    public async Detail(index: number = 0): Promise<ReleaseDetailPageViewModel>
    {
        const list = await this.List()
        list.Rows.Get(index)?.OpenCommand.Execute()
        await Tick.Settle()
        assert.ok(this.Content instanceof ReleaseDetailPageViewModel)
        return this.Content
    }
}

describe('Registry & Releases section', () =>
{
    it('the list shows each version newest first with channel, signature, status and adoption', async () =>
    {
        const fx = new ReleasesFixture()
        const list = await fx.List()
        assert.equal(list.State, PageState.Populated)
        assert.deepEqual(list.Rows.ToArray().map(r => [r.Version, r.ChannelLabel, r.SignatureLabel, r.StatusLabel, r.PublishedLabel, r.AdoptionLabel]), [
            ['1.4.0', 'Stable', 'Signed', 'Published', '2026-10-12', '1 environment'],
            ['1.3.0', 'Early access', 'Unsigned', 'Published', '2026-10-01', 'Not running anywhere'],
        ])
    })

    it('no versions -> Empty', async () =>
    {
        const fx = new ReleasesFixture()
        fx.Api.Manifests = []
        const list = await fx.List()
        assert.equal(list.State, PageState.Empty)
    })

    it('list -> detail: manifest, digest, notes and where it runs; Back returns', async () =>
    {
        const fx = new ReleasesFixture()
        const detail = await fx.Detail()
        assert.equal(detail.State, PageState.Populated)
        assert.equal(detail.Version, '1.4.0')
        assert.equal(detail.Image, 'img:0')
        assert.equal(detail.DigestLabel, 'abcdef012345')
        assert.equal(detail.NotesLabel, 'Faster graphs')
        assert.equal(detail.ChannelLabel, 'Stable')
        assert.equal(detail.IsWithdrawn, false)
        assert.deepEqual(detail.AdoptionRows.ToArray().map(r => [r.HiveName, r.OwnerLabel, r.Environment, r.ReadyLabel]), [
            ['Hive acme-hive', 'Acme / Acme Production', 'env0', 'Ready'],
        ])
        assert.equal(detail.HasAdoption, true)
        detail.BackCommand.Execute()
        assert.ok(fx.Content instanceof ReleasesPageViewModel)
    })

    it('Publish goes through a dialog and calls PublishManifest with its fields', async () =>
    {
        const fx = new ReleasesFixture()
        const list = await fx.List()
        list.PublishCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last
        assert.ok(dialog instanceof PublishDialogViewModel)
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.Version = ' 1.5.0 '
        dialog.Image = 'img:new'
        dialog.Notes = 'Adds exports'
        dialog.SelectedChannel = dialog.Channels.ToArray().find(c => c.Value === 'early')
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Published, [['1.5.0', 'img:new', 'Adds exports', 'early']])
        assert.equal(fx.Dialogs.IsOpen, false)
        assert.equal(fx.Content, list)
        assert.ok(list.Rows.ToArray().some(r => r.Version === '1.5.0'))
    })

    it('Publish with blank notes sends no notes and defaults to the Stable channel', async () =>
    {
        const fx = new ReleasesFixture()
        const list = await fx.List()
        list.PublishCommand.Execute()
        await Tick.Settle()
        const dialog = fx.Dialogs.Last as PublishDialogViewModel
        dialog.Version = '1.5.0'
        dialog.Image = 'img:new'
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Published, [['1.5.0', 'img:new', undefined, 'stable']])
    })

    it('Withdraw asks for the version and a reason, then records the reason', async () =>
    {
        const fx = new ReleasesFixture()
        const detail = await fx.Detail()
        assert.equal(detail.RestoreCommand.CanExecute(), false)
        detail.WithdrawCommand.Execute()
        await Tick.Settle()
        const confirm = fx.Dialogs.Last
        assert.ok(confirm instanceof NameConfirmDialogViewModel)
        assert.equal(confirm.ConfirmLabel, 'Withdraw')
        assert.equal(confirm.RequiresReason, true)
        confirm.Typed = '1.4.0'
        assert.equal(confirm.ConfirmCommand.CanExecute(), false)
        confirm.Reason = 'Breaks graph export'
        assert.equal(confirm.ConfirmCommand.CanExecute(), true)
        confirm.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Withdrawals, [['1.4.0', true, 'Breaks graph export']])
        assert.equal(fx.Content, detail)
        assert.equal(detail.IsWithdrawn, true)
        assert.equal(detail.StatusLabel, 'Withdrawn')
        assert.match(detail.WithdrawnText, /Breaks graph export/)
        assert.equal(detail.WithdrawCommand.CanExecute(), false)
        assert.equal(detail.RestoreCommand.CanExecute(), true)
    })

    it('Restore returns a withdrawn version to offers', async () =>
    {
        const fx = new ReleasesFixture()
        fx.Api.Manifests[0].withdrawn = true
        const detail = await fx.Detail()
        detail.RestoreCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Withdrawals, [['1.4.0', false, undefined]])
        assert.equal(detail.IsWithdrawn, false)
    })

    it('Observer: Publish, Withdraw and Restore are disabled and never open a dialog', async () =>
    {
        const fx = new ReleasesFixture(OperatorContext.ReadOnlyWireRole)
        const list = await fx.List()
        assert.equal(list.PublishCommand.CanExecute(), false)
        assert.notEqual(list.DeniedReason, '')
        list.PublishCommand.Execute()
        const detail = await fx.Detail()
        assert.equal(detail.WithdrawCommand.CanExecute(), false)
        assert.equal(detail.RestoreCommand.CanExecute(), false)
        detail.WithdrawCommand.Execute()
        detail.RestoreCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Dialogs.Shown.length, 0)
        assert.deepEqual(fx.Api.Withdrawals, [])
    })
})
