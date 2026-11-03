import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../../../api-client.js'
import { OperatorContext } from '../../../operator-context.js'
import { NameConfirmDialogViewModel } from '../../../shell/name-confirm-dialog-view-model.js'
import { PendingSecret } from '../../../shell/holds-pending-secret.js'
import { FakeControlPlane, PortalTestHost, Tick, type FakeDialogService } from '../../../shell/tests/portal-test-fixtures.js'
import { AgentTokenRevealPageViewModel } from '../agent-token-reveal-page-view-model.js'
import { HiveDetailPageViewModel } from '../hive-detail-page-view-model.js'
import { HiveInstallMode, HiveInstallViewModel } from '../hive-install-view-model.js'
import { HivesPageViewModel } from '../hives-page-view-model.js'
import { HivesSectionService } from '../hives-section-service.js'

// A Hives section over a fake control plane, with fake dialogs, clipboard and downloads.
class InstallFixture
{
    public readonly Api: FakeControlPlane
    public readonly Host: PortalTestHost
    public readonly Dialogs: FakeDialogService
    public readonly Clipboard: string[]
    public readonly Downloads: Array<[string, string]>
    public readonly Section: HivesSectionService

    public constructor(wireRole: string = OperatorContext.FullWireRole)
    {
        this.Api = new FakeControlPlane()
            .WithClient('acme', 'Acme')
            .WithTenant('acme-prod', 'acme', 'Acme Production')
            .WithHive('acme-hive', 'acme-prod')
        this.Host = new PortalTestHost(this.Api.AsClient(), wireRole)
        this.Dialogs = this.Host.UseDialogs()
        this.Clipboard = this.Host.UseClipboard()
        this.Downloads = this.Host.UseDownloads()
        this.Section = new HivesSectionService(this.Host.Provider)
    }

    public get Content(): unknown
    {
        return this.Host.Host.Content
    }

    public Install(mode: HiveInstallMode): HiveInstallViewModel
    {
        return new HiveInstallViewModel(this.Host.Session, this.Section, mode)
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

    // Reissues the token from the hive detail and returns its reveal page.
    public async Reissued(): Promise<AgentTokenRevealPageViewModel>
    {
        const detail = await this.Detail()
        detail.ReissueTokenCommand.Execute()
        await Tick.Settle()
        const confirm = this.Dialogs.Last
        assert.ok(confirm instanceof NameConfirmDialogViewModel)
        confirm.Typed = 'acme-hive'
        confirm.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.ok(this.Content instanceof AgentTokenRevealPageViewModel)
        return this.Content
    }
}

describe('Hive agent install', () =>
{
    it('first install: apply the bundle, read the token silently, create the token Secret from it', async () =>
    {
        const fx = new InstallFixture()
        const install = fx.Install(HiveInstallMode.FirstInstall)
        await install.Load('acme-hive')
        assert.equal(install.HasBundle, true)
        assert.equal(install.FileName, 'bootstrap-acme-hive.json')
        assert.equal(install.ChannelUrl, 'http://host.docker.internal:7001')
        assert.equal(install.Commands, [
            'kubectl apply -f bootstrap-acme-hive.json',
            'read -rs PRAGMATIC_AGENT_TOKEN   # paste the one-time agent token, then press Enter',
            'kubectl -n pragmatic-system create secret generic pragmatic-hive-acme-hive-agent-token --from-literal=token="$PRAGMATIC_AGENT_TOKEN" --dry-run=client -o yaml | kubectl apply --server-side --field-manager=pragmatic-operator --force-conflicts -f -',
        ].join('\n'))
    })

    it('rotation: replace the Secret in place, then restart every hive deployment that reads it', async () =>
    {
        const fx = new InstallFixture()
        const install = fx.Install(HiveInstallMode.Rotate)
        await install.Load('acme-hive')
        assert.equal(install.Commands, [
            'read -rs PRAGMATIC_AGENT_TOKEN   # paste the one-time agent token, then press Enter',
            'kubectl -n pragmatic-system create secret generic pragmatic-hive-acme-hive-agent-token --from-literal=token="$PRAGMATIC_AGENT_TOKEN" --dry-run=client -o yaml | kubectl apply --server-side --field-manager=pragmatic-operator --force-conflicts -f -',
            'kubectl -n pragmatic-system rollout restart deployment -l pragmatic/hive=acme-hive',
        ].join('\n'))
    })

    it('overlapping loads: only the latest applies, and loading ends with it', async () =>
    {
        const fx = new InstallFixture()
        const install = fx.Install(HiveInstallMode.FirstInstall)
        fx.Api.BootstrapFailure = new ApiError(500, 'transient')
        const first = install.Load('acme-hive')
        fx.Api.BootstrapFailure = undefined
        const second = install.Load('acme-hive')
        await second
        await first
        assert.equal(install.HasBundle, true)
        assert.equal(install.ErrorText, '')
        assert.equal(install.IsLoading, false)
    })

    it('Download saves the manifest under its file name; Copy commands copies the commands', async () =>
    {
        const fx = new InstallFixture()
        const install = fx.Install(HiveInstallMode.FirstInstall)
        assert.equal(install.DownloadCommand.CanExecute(), false)
        await install.Load('acme-hive')
        assert.equal(install.DownloadCommand.CanExecute(), true)
        install.DownloadCommand.Execute()
        assert.deepEqual(fx.Downloads, [['bootstrap-acme-hive.json', '{"apiVersion":"v1","kind":"List","items":[]}']])
        install.CopyCommandsCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Clipboard, [install.Commands])
        assert.equal(install.Status, 'Copied.')
    })

    it('a refused bundle (agent channel off) shows its reason and offers no download', async () =>
    {
        const fx = new InstallFixture()
        fx.Api.BootstrapFailure = new ApiError(409, 'The agent channel is not configured')
        const install = fx.Install(HiveInstallMode.FirstInstall)
        await install.Load('acme-hive')
        assert.equal(install.HasBundle, false)
        assert.equal(install.ErrorText, 'The agent channel is not configured')
        assert.equal(install.DownloadCommand.CanExecute(), false)
        assert.equal(install.Commands, '')
    })

    it('a 401 on the bundle shows in the panel and never reloads (a reload would lose a token on screen)', async () =>
    {
        const fx = new InstallFixture()
        fx.Api.BootstrapFailure = new ApiError(ApiError.UnauthorizedStatus, 'unauthenticated')
        const install = fx.Install(HiveInstallMode.Rotate)
        await install.Load('acme-hive')
        assert.equal(fx.Host.Reloader.Count, 0)
        assert.equal(install.ErrorText, 'unauthenticated')
    })

    it('the hive detail loads its install bundle', async () =>
    {
        const fx = new InstallFixture()
        const detail = await fx.Detail()
        assert.equal(detail.Install.HasBundle, true)
        assert.ok(detail.Install.Commands.startsWith('kubectl apply -f bootstrap-acme-hive.json'))
    })

    it('Reissue asks for the hive id, then reveals the new token with the rotation commands', async () =>
    {
        const fx = new InstallFixture()
        const reveal = await fx.Reissued()
        assert.deepEqual(fx.Api.Reissued, ['acme-hive'])
        assert.equal(reveal.Value, fx.Api.ReissuedToken)
        assert.equal(reveal.HasPendingSecret, true)
        assert.ok(reveal.Install.Commands.includes('rollout restart deployment -l pragmatic/hive=acme-hive'))
        // The token is on the page once, never in the commands (or anything copied from them).
        assert.ok(!reveal.Install.Commands.includes(fx.Api.ReissuedToken))
    })

    it('confirming the reissued token clears it and its commands, then returns to the hive', async () =>
    {
        const fx = new InstallFixture()
        const reveal = await fx.Reissued()
        let raised = 0
        const subscription = reveal.PropertyChanged(PendingSecret.ChangedProperty).subscribe(() => { raised++ })
        reveal.Saved = true
        reveal.ConfirmSavedCommand.Execute()
        await Tick.Settle()
        subscription.dispose()
        assert.equal(raised, 1)
        assert.equal(reveal.Value, '')
        assert.ok(fx.Content instanceof HiveDetailPageViewModel)
    })

    it('a cancelled reissue mints nothing', async () =>
    {
        const fx = new InstallFixture()
        const detail = await fx.Detail()
        detail.ReissueTokenCommand.Execute()
        await Tick.Settle()
        fx.Dialogs.Dismiss()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Reissued, [])
        assert.equal(fx.Content, detail)
    })

    it('Observer: Reissue is disabled and never opens a dialog', async () =>
    {
        const fx = new InstallFixture(OperatorContext.ReadOnlyWireRole)
        const detail = await fx.Detail()
        assert.equal(detail.ReissueTokenCommand.CanExecute(), false)
        detail.ReissueTokenCommand.Execute()
        await Tick.Settle()
        assert.equal(fx.Dialogs.Shown.length, 0)
        assert.deepEqual(fx.Api.Reissued, [])
    })
})
