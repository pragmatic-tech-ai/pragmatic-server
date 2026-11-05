import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../../../api-client.js'
import { OperatorContext } from '../../../operator-context.js'
import { ConsoleInstallState, ConsoleInstallStep, IngressTlsSource } from '../../../portal-types.js'
import type { IClipboardSource } from '../../../shell/one-time-secret-page-view-model.js'
import type { OptionViewModel } from '../../../shell/option-view-model.js'
import { FakeControlPlane, Inspect, PortalTestHost, TestRail, Tick, type FakePollScheduler } from '../../../shell/tests/portal-test-fixtures.js'
import { TenantsSectionService } from '../../tenants/tenants-section-service.js'
import { AgentInstallStepState } from '../hive-agent-install-view-model.js'
import { HiveConsoleViewModel } from '../hive-console-view-model.js'
import { HiveDetailPageViewModel } from '../hive-detail-page-view-model.js'
import { HivesPageViewModel } from '../hives-page-view-model.js'
import { HivesSectionService } from '../hives-section-service.js'

// The Hives and Tenants sections behind a real rail, over a fake control plane
// with one Local hive h1 of tenant acme, with hand-driven polls.
class ConsoleFixture
{
    public readonly Api: FakeControlPlane
    public readonly Host: PortalTestHost
    public readonly Polls: FakePollScheduler
    public readonly Rail: TestRail
    public readonly Copied: string[]

    public constructor(wireRole: string = OperatorContext.FullWireRole)
    {
        this.Api = new FakeControlPlane()
            .WithClient('acme-co', 'Acme')
            .WithTenant('acme', 'acme-co', 'Acme')
            .WithHive('h1', 'acme')
        this.Api.AutoInstall = true
        this.Host = new PortalTestHost(this.Api.AsClient(), wireRole)
        this.Host.UseDialogs()
        this.Copied = this.Host.UseClipboard()
        this.Polls = this.Host.UsePolls()
        this.Host.Provider.register(HivesSectionService.Key, (p) => new HivesSectionService(p))
        this.Host.Provider.register(TenantsSectionService.Key, (p) => new TenantsSectionService(p))
        this.Rail = new TestRail(this.Host.Provider)
        this.Rail.Add(HivesSectionService)
        this.Rail.Add(TenantsSectionService)
    }

    public get Content(): unknown
    {
        return this.Host.Host.Content
    }

    public get Section(): HivesSectionService
    {
        return this.Host.Provider.getRequired(HivesSectionService.Key)
    }

    // A bare console panel for h1, loaded with its record (copying through the section, or the given source).
    public Panel(clipboard: IClipboardSource = this.Section): HiveConsoleViewModel
    {
        const panel = new HiveConsoleViewModel(this.Host.Session, 'h1', clipboard, this.Polls)
        panel.Load(this.Api.Hives[0]!)
        return panel
    }

    // A panel whose settings are saved (development TLS under localtest.me).
    public async Configured(): Promise<HiveConsoleViewModel>
    {
        const panel = this.Panel()
        panel.BaseDomain = 'localtest.me'
        panel.SelectedTls = ConsoleFixture.Option(panel, IngressTlsSource.Development)
        await panel.Save()
        return panel
    }

    public async Detail(): Promise<HiveDetailPageViewModel>
    {
        this.Rail.Select(HivesSectionService)
        await Tick.Settle()
        assert.ok(this.Content instanceof HivesPageViewModel)
        this.Content.Rows.Get(0)?.OpenCommand.Execute()
        await Tick.Settle()
        assert.ok(this.Content instanceof HiveDetailPageViewModel)
        return this.Content
    }

    public static Option(panel: HiveConsoleViewModel, source: IngressTlsSource): OptionViewModel<IngressTlsSource>
    {
        const option = panel.TlsOptions.ToArray().find(o => o.Value === source)
        assert.ok(option !== undefined)
        return option
    }

    // Lets the queued poll run and its read land.
    public async Poll(): Promise<void>
    {
        this.Polls.RunPending()
        await Tick.Settle()
    }
}

describe('Hive tenant console (panel)', () =>
{
    it('IsReported is not a bound value: no markup binds it, StatusText carries the Reported state', () =>
    {
        const bound = Reflect.get(HiveConsoleViewModel, 'BoundProperties') as readonly string[]
        assert.equal(bound.includes('IsReported'), false)
        assert.equal(bound.includes('StatusText'), true)
    })

    it('Save sends the console spec', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = fx.Panel()
        assert.equal(panel.IsConfigured, false)
        panel.BaseDomain = 'localtest.me'
        panel.Host = ''
        panel.SelectedTls = ConsoleFixture.Option(panel, IngressTlsSource.Development)
        assert.equal(panel.IsDevelopment, true)
        assert.equal(panel.HostPlaceholder, 'console-acme.localtest.me')
        assert.equal(panel.SaveCommand.CanExecute(), true)
        panel.SaveCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.ConsoleSaves, [['h1', { baseDomain: 'localtest.me', tls: { source: 'development' } }]])
        assert.equal('host' in (fx.Api.ConsoleSaves[0]![1]), false)
        assert.equal(panel.IsConfigured, true)
        assert.equal(panel.ErrorText, '')
    })

    it('the ingress controller namespace is optional (placeholder ingress-nginx), sent trimmed when typed, and shown from saved settings', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = fx.Panel()
        assert.equal(panel.IngressNamespace, '')
        assert.equal(panel.IngressNamespacePlaceholder, 'ingress-nginx')
        panel.BaseDomain = 'localtest.me'
        panel.SelectedTls = ConsoleFixture.Option(panel, IngressTlsSource.Development)
        panel.IngressNamespace = ' kube-system '
        await panel.Save()
        assert.deepEqual(fx.Api.ConsoleSaves, [['h1', { baseDomain: 'localtest.me', tls: { source: 'development' }, ingressNamespace: 'kube-system' }]])
        const shown = new ConsoleFixture().Panel()
        shown.Load({ ...fx.Api.Hives[0]!, console: { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development }, ingressNamespace: 'ingress' } })
        assert.equal(shown.IngressNamespace, 'ingress')
    })

    it('existing-secret needs a Secret name before Save is enabled', () =>
    {
        const fx = new ConsoleFixture()
        const panel = fx.Panel()
        panel.BaseDomain = 'example.com'
        panel.SelectedTls = ConsoleFixture.Option(panel, IngressTlsSource.ExistingSecret)
        assert.equal(panel.IsExistingSecret, true)
        assert.equal(panel.SaveCommand.CanExecute(), false)
        let raised = 0
        panel.SaveCommand.AddCanExecuteChangedListener(() => { raised++ })
        panel.SecretName = 'acme-console-tls'
        assert.equal(panel.SaveCommand.CanExecute(), true)
        assert.ok(raised > 0)
    })

    it('cert-manager needs an issuer', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = fx.Panel()
        panel.BaseDomain = 'example.com'
        panel.Host = 'console.example.com'
        panel.SecretName = 'left-over'
        panel.SelectedTls = ConsoleFixture.Option(panel, IngressTlsSource.CertManager)
        assert.equal(panel.IsCertManager, true)
        assert.equal(panel.SaveCommand.CanExecute(), false)
        panel.ClusterIssuer = 'letsencrypt'
        assert.equal(panel.SaveCommand.CanExecute(), true)
        await panel.Save()
        assert.deepEqual(fx.Api.ConsoleSaves, [['h1', { baseDomain: 'example.com', host: 'console.example.com', tls: { source: 'cert-manager', clusterIssuer: 'letsencrypt' } }]])
    })

    it('a 400 from Save shows the server sentence in ErrorText', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = fx.Panel()
        panel.BaseDomain = 'co.uk'
        panel.SelectedTls = ConsoleFixture.Option(panel, IngressTlsSource.Development)
        fx.Api.ConsoleFailure = new ApiError(400, 'The base domain must be a lowercase host name of at least two labels, such as example.com (not a public suffix such as co.uk).')
        await panel.Save()
        assert.equal(panel.ErrorText, 'The base domain must be a lowercase host name of at least two labels, such as example.com (not a public suffix such as co.uk).')
        assert.equal(panel.IsConfigured, false)
        assert.equal(panel.SaveCommand.CanExecute(), true)
    })

    it('Install polls every 2 seconds until deployed and shows the waiting text', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        assert.equal(panel.InstallCommand.CanExecute(), true)
        panel.InstallCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.ConsoleInstallStarts, ['h1'])
        assert.equal(panel.IsInstalling, true)
        assert.equal(panel.InstallCommand.CanExecute(), false)
        assert.equal(panel.SaveCommand.CanExecute(), false)
        assert.equal(panel.SetOwnerPasswordCommand.CanExecute(), false)
        assert.deepEqual(panel.Steps.ToArray().map(s => s.Label), [
            'Check the hive agent', 'Prepare certificates', 'Apply the console', 'Store its secrets', 'Wait for it to start', 'Create the Owner account',
        ])
        assert.deepEqual(fx.Polls.Delays, [2000])
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Installing, ConsoleInstallStep.ApplyingConsole)]
        await fx.Poll()
        assert.deepEqual(panel.Steps.ToArray().map(s => s.State), [
            AgentInstallStepState.Done, AgentInstallStepState.Done, AgentInstallStepState.Running,
            AgentInstallStepState.Pending, AgentInstallStepState.Pending, AgentInstallStepState.Pending,
        ])
        assert.equal(fx.Polls.Pending, 1)
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Deployed, ConsoleInstallStep.SeedingOwner, {
            consoleUrl: 'https://console-acme.localtest.me', devCaFile: 'C:\\data\\dev-ca\\localtest.me\\ca.crt',
        })]
        await fx.Poll()
        assert.equal(panel.IsDeployed, true)
        assert.equal(panel.StatusText, 'Deployed. Waiting for the console to report.')
        assert.equal(panel.ConsoleUrl, 'https://console-acme.localtest.me')
        assert.ok(panel.Steps.ToArray().every(s => s.IsDone))
        // Deployed: the panel keeps waiting for the console's report, at the slower interval.
        assert.equal(fx.Polls.Pending, 1)
        assert.deepEqual(fx.Polls.Delays, [2000, 2000, 15000])
        assert.equal(panel.SetOwnerPasswordCommand.CanExecute(), true)
        assert.equal(panel.InstallCommand.CanExecute(), true)
    })

    it('after deployed it keeps polling every 15 seconds until reported', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        await panel.Install()
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Deployed, ConsoleInstallStep.SeedingOwner, { consoleUrl: 'https://console-acme.localtest.me' })]
        await fx.Poll()
        assert.equal(panel.IsDeployed, true)
        assert.equal(panel.IsReported, false)
        await fx.Poll()
        assert.equal(panel.IsReported, false)
        assert.equal(fx.Polls.Pending, 1)
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Reported, ConsoleInstallStep.SeedingOwner, {
            consoleUrl: 'https://console-acme.localtest.me', reportedAt: '2026-11-04T10:07:00.000Z', stale: false,
        })]
        await fx.Poll()
        assert.equal(HiveConsoleViewModel.ReportPollIntervalMs, 15000)
        assert.deepEqual(fx.Polls.Delays, [2000, 15000, 15000])
        assert.equal(fx.Polls.Pending, 0)
        assert.equal(panel.IsReported, true)
        assert.equal(panel.IsDeployed, true)
        assert.equal(panel.IsInstalling, false)
        assert.ok(panel.StatusText.startsWith('Reported by the console at'))
        assert.equal(panel.StatusText, 'Reported by the console at 2026-11-04 10:07.')
        assert.equal(panel.ConsoleUrl, 'https://console-acme.localtest.me')
        assert.ok(panel.Steps.ToArray().every(s => s.IsDone))
        // Reinstall stays offered once the console reported.
        assert.equal(panel.InstallCommand.CanExecute(), true)
        assert.equal(panel.SetOwnerPasswordCommand.CanExecute(), true)
    })

    it('a transient read failure while deployed keeps waiting for the report', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Deployed, ConsoleInstallStep.SeedingOwner)]
        await panel.Resume()
        assert.deepEqual(fx.Polls.Delays, [15000])
        fx.Api.GetConsoleInstall = async () => { throw new ApiError(502, 'Bad gateway') }
        await fx.Poll()
        assert.equal(panel.IsDeployed, true)
        assert.deepEqual(fx.Polls.Delays, [15000, 15000])
    })

    it('a stale report says so', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Reported, ConsoleInstallStep.SeedingOwner, {
            reportedAt: '2026-11-02T08:15:00.000Z', stale: true,
        })]
        await panel.Resume()
        assert.equal(panel.IsReported, true)
        assert.equal(panel.StatusText, 'Last reported at 2026-11-02 08:15, more than a day ago.')
        assert.equal(fx.Polls.Pending, 0)
    })

    it('a reported status without a report time says so without a placeholder date', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Reported, ConsoleInstallStep.SeedingOwner)]
        await panel.Resume()
        assert.equal(panel.StatusText, 'Reported by the console.')
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Reported, ConsoleInstallStep.SeedingOwner, { stale: true })]
        await panel.Resume()
        assert.equal(panel.StatusText, 'The console last reported more than a day ago.')
    })

    it('Stop cancels the 15 second wait of a deployed console; no read lands after it', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Deployed, ConsoleInstallStep.SeedingOwner)]
        await panel.Resume()
        assert.equal(fx.Polls.Pending, 1)
        assert.deepEqual(fx.Polls.Delays, [15000])
        panel.Stop()
        assert.equal(fx.Polls.Pending, 0)
        const reads = fx.Api.ConsoleInstallReads
        await fx.Poll()
        assert.equal(fx.Api.ConsoleInstallReads, reads)
        assert.equal(fx.Polls.Pending, 0)
    })

    it('a new Install from deployed replaces the 15 second wait with the install polling', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Deployed, ConsoleInstallStep.SeedingOwner)]
        await panel.Resume()
        assert.deepEqual(fx.Polls.Delays, [15000])
        await panel.Install()
        assert.equal(panel.IsInstalling, true)
        assert.equal(fx.Polls.Pending, 1)
        assert.deepEqual(fx.Polls.Delays, [15000, 2000])
    })

    it('a new Install from reported starts the install polling', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Reported, ConsoleInstallStep.SeedingOwner, { reportedAt: '2026-11-04T10:07:00.000Z' })]
        await panel.Resume()
        assert.equal(fx.Polls.Pending, 0)
        await panel.Install()
        assert.equal(panel.IsInstalling, true)
        assert.equal(panel.IsReported, false)
        assert.equal(fx.Polls.Pending, 1)
        assert.deepEqual(fx.Polls.Delays, [2000])
    })

    it('a reported console whose step is not the last still shows every step done', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Reported, ConsoleInstallStep.WaitingForRollout, { reportedAt: '2026-11-04T10:07:00.000Z' })]
        await panel.Resume()
        assert.ok(panel.Steps.ToArray().every(s => s.IsDone))
    })

    it('the dev trust command quotes the CA path', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        assert.equal(panel.DevTrustCommand, '')
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Deployed, ConsoleInstallStep.SeedingOwner, {
            consoleUrl: 'https://console-acme.localtest.me', devCaFile: 'C:\\data\\dev-ca\\localtest.me\\ca.crt',
        })]
        await panel.Resume()
        assert.ok(panel.DevTrustCommand.startsWith('powershell -NoProfile -ExecutionPolicy Bypass -File admin\\control-plane\\dev\\dev-ca-trust.ps1 -Install'))
        assert.ok(panel.DevTrustCommand.endsWith('-CaFile "C:\\data\\dev-ca\\localtest.me\\ca.crt"'))
    })

    it('a failed step shows its error and Retry starts a fresh run', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        await panel.Install()
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Failed, ConsoleInstallStep.PreparingCertificates, {
            error: 'The TLS Secret acme-tls in pragmatic-system is not a kubernetes.io/tls Secret.',
        })]
        await fx.Poll()
        assert.equal(panel.IsFailed, true)
        assert.equal(panel.ErrorText, 'The TLS Secret acme-tls in pragmatic-system is not a kubernetes.io/tls Secret.')
        assert.equal(panel.Steps.Get(1)?.State, AgentInstallStepState.Failed)
        assert.equal(panel.RetryCommand.CanExecute(), true)
        panel.RetryCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.ConsoleInstallStarts, ['h1', 'h1'])
        assert.equal(panel.IsInstalling, true)
        assert.equal(panel.ErrorText, '')
    })

    it('a refused install (another one running) follows the running install', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        fx.Api.ConsoleFailure = new ApiError(409, 'A console install is running for this hive. Wait for it to finish (or fail), then try again.')
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Installing, ConsoleInstallStep.StoringSecrets)]
        await panel.Install()
        assert.equal(panel.IsInstalling, true)
        assert.equal(panel.ErrorText, '')
        assert.equal(fx.Polls.Pending, 1)
    })

    it('the Owner password 503 (in-hive IdP unreachable) shows its reason', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Deployed, ConsoleInstallStep.SeedingOwner)]
        await panel.Resume()
        fx.Api.ConsoleFailure = new ApiError(503, "The hive's identity provider could not be reached.")
        await panel.SetOwnerPassword()
        assert.equal(panel.ErrorText, "The hive's identity provider could not be reached.")
        assert.equal(panel.OwnerPassword, '')
        assert.equal(panel.HasOwnerPassword, false)
    })

    it('Remove asks first, then removes the console and clears the settings', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        assert.equal(panel.RemoveCommand.CanExecute(), true)
        panel.RemoveCommand.Execute()
        assert.equal(panel.IsConfirmingRemove, true)
        assert.deepEqual(fx.Api.ConsoleRemovals, [])
        panel.CancelRemoveCommand.Execute()
        assert.equal(panel.IsConfirmingRemove, false)
        panel.RemoveCommand.Execute()
        panel.ConfirmRemoveCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.ConsoleRemovals, ['h1'])
        assert.equal(panel.IsConfigured, false)
        assert.equal(panel.IsConfirmingRemove, false)
        assert.equal(panel.RemoveCommand.CanExecute(), false)
    })

    it('a removal names what stays in the cluster: the kept data and the environments that keep running', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        assert.equal(panel.RemovalNote, '')
        fx.Api.ConsoleRemovalRetained = ['pragmatic-tenant-admin-acme-data', 'pragmatic-env-dev']
        panel.RemoveCommand.Execute()
        await panel.ConfirmRemove()
        assert.equal(panel.RemovalNote, 'The console was removed. Kept in the cluster: pragmatic-tenant-admin-acme-data, pragmatic-env-dev. Kept environments keep running unmanaged until the console is reinstalled; they are removed with the hive.')
        panel.Stop()
        assert.equal(panel.RemovalNote, '')
    })

    it('a removal whose kept objects could not be listed shows the control plane notice', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        fx.Api.ConsoleRemovalNotice = 'The console was removed, but the objects it kept could not be listed: connection refused.'
        panel.RemoveCommand.Execute()
        await panel.ConfirmRemove()
        assert.equal(panel.RemovalNote, 'The console was removed, but the objects it kept could not be listed: connection refused.')
        assert.equal(panel.IsConfigured, false)
    })

    it('a removal that kept nothing says only that the console was removed', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        panel.RemoveCommand.Execute()
        await panel.ConfirmRemove()
        assert.equal(panel.RemovalNote, 'The console was removed.')
    })

    it('a refused start (another hive operation runs) stays Idle and shows only the sentence', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        fx.Api.ConsoleFailure = new ApiError(409, 'An agent install is running for this hive. Wait for it to finish (or fail) before installing the console.')
        await panel.Install()
        assert.equal(panel.IsIdle, true)
        assert.equal(panel.IsFailed, false)
        assert.equal(panel.HasProgress, false)
        assert.equal(panel.StatusText, '')
        assert.equal(panel.ErrorText, 'An agent install is running for this hive. Wait for it to finish (or fail) before installing the console.')
        assert.equal(panel.RetryCommand.CanExecute(), false)
        assert.equal(fx.Polls.Pending, 0)
    })

    it('a refused reinstall keeps the deployed install showing', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Deployed, ConsoleInstallStep.SeedingOwner, { consoleUrl: 'https://console-acme.localtest.me' })]
        await panel.Resume()
        fx.Api.ConsoleFailure = new ApiError(409, 'Another operation is running for this hive. Wait for it to finish, then try again.')
        await panel.Install()
        assert.equal(panel.IsDeployed, true)
        assert.equal(panel.ConsoleUrl, 'https://console-acme.localtest.me')
        assert.ok(panel.Steps.ToArray().every(s => s.IsDone))
        assert.equal(panel.ErrorText, 'Another operation is running for this hive. Wait for it to finish, then try again.')
        // The wait for the console's report goes on.
        assert.equal(fx.Polls.Pending, 1)
        assert.equal(fx.Polls.Delays[fx.Polls.Delays.length - 1], 15000)
    })

    it('a 409 from Save (a console install runs) shows its sentence', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = fx.Panel()
        panel.BaseDomain = 'localtest.me'
        panel.SelectedTls = ConsoleFixture.Option(panel, IngressTlsSource.Development)
        fx.Api.ConsoleFailure = new ApiError(409, 'A console install is running for this hive. Wait for it to finish (or fail), then try again.')
        await panel.Save()
        assert.equal(panel.ErrorText, 'A console install is running for this hive. Wait for it to finish (or fail), then try again.')
        assert.equal(panel.IsConfigured, false)
    })

    it('after a control-plane restart (no install status) a configured console still offers Set Owner password', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        fx.Api.ConsoleInstallReplies = []
        await panel.Resume()
        assert.equal(panel.IsIdle, true)
        assert.equal(panel.SetOwnerPasswordCommand.CanExecute(), true)
        panel.SetOwnerPasswordCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.InHiveOwnerResets, ['h1'])
        assert.equal(panel.OwnerPassword, fx.Api.InHiveOwnerPassword)
    })

    it('an unconfigured console offers no Set Owner password', () =>
    {
        const fx = new ConsoleFixture()
        const panel = fx.Panel()
        assert.equal(panel.SetOwnerPasswordCommand.CanExecute(), false)
    })

    it('Copy puts the Owner password on the clipboard and reports it without echoing it; Stop clears the status', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        await panel.Resume()
        assert.equal(panel.CopyPasswordCommand.CanExecute(), false)
        await panel.SetOwnerPassword()
        assert.equal(panel.CopyPasswordCommand.CanExecute(), true)
        panel.CopyPasswordCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Copied, [fx.Api.InHiveOwnerPassword])
        assert.equal(panel.PasswordCopyStatus, 'Copied.')
        panel.Stop()
        assert.equal(panel.PasswordCopyStatus, '')
        assert.equal(panel.OwnerPassword, '')
    })

    it('Copy reports a failure when there is no clipboard', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = fx.Panel({ Clipboard: undefined })
        panel.BaseDomain = 'localtest.me'
        panel.SelectedTls = ConsoleFixture.Option(panel, IngressTlsSource.Development)
        await panel.Save()
        await panel.Resume()
        await panel.SetOwnerPassword()
        panel.CopyPasswordCommand.Execute()
        await Tick.Settle()
        assert.equal(panel.PasswordCopyStatus, 'Could not copy. Select the value and copy it by hand.')
        assert.deepEqual(fx.Copied, [])
    })

    it('Copy puts the dev trust command on the clipboard', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        assert.equal(panel.CopyTrustCommandCommand.CanExecute(), false)
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Deployed, ConsoleInstallStep.SeedingOwner, {
            devCaFile: 'C:\\data\\dev-ca\\localtest.me\\ca.crt',
        })]
        await panel.Resume()
        panel.CopyTrustCommandCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Copied, [panel.DevTrustCommand])
        assert.equal(panel.TrustCopyStatus, 'Copied.')
    })

    it('a reload keeps unsaved edits; once saved, a reload shows the saved settings', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        panel.BaseDomain = 'example.test'
        panel.Load(fx.Api.Hives[0]!)
        assert.equal(panel.BaseDomain, 'example.test')
        assert.equal(panel.IsConfigured, true)
        await panel.Save()
        fx.Api.Hives[0]!.console = { baseDomain: 'other.test', tls: { source: IngressTlsSource.Development } }
        panel.Load(fx.Api.Hives[0]!)
        assert.equal(panel.BaseDomain, 'other.test')
    })

    it('clearing the Owner password never carries the old value in its change notification', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        await panel.Resume()
        await panel.SetOwnerPassword()
        const olds: unknown[] = []
        panel.PropertyChanged('OwnerPassword').subscribe(e => olds.push(e.oldValue))
        panel.Stop()
        assert.equal(panel.OwnerPassword, '')
        assert.deepEqual(olds, [''])
    })

    it('a removal the cluster refused shows its reason and keeps the settings', async () =>
    {
        const fx = new ConsoleFixture()
        const panel = await fx.Configured()
        panel.RemoveCommand.Execute()
        fx.Api.ConsoleFailure = new ApiError(409, "Could not remove the hive's console from its cluster: connection refused")
        await panel.ConfirmRemove()
        assert.equal(panel.ErrorText, "Could not remove the hive's console from its cluster: connection refused")
        assert.equal(panel.IsConfigured, true)
    })

    it('a read-only operator can neither save, install nor set the Owner password', async () =>
    {
        const fx = new ConsoleFixture(OperatorContext.ReadOnlyWireRole)
        fx.Api.Hives[0]!.console = { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development } }
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Deployed, ConsoleInstallStep.SeedingOwner)]
        const panel = fx.Panel()
        await panel.Resume()
        assert.equal(panel.IsConfigured, true)
        assert.equal(panel.IsDeployed, true)
        assert.equal(panel.BaseDomain, 'localtest.me')
        assert.equal(panel.IsDevelopment, true)
        assert.equal(panel.SaveCommand.CanExecute(), false)
        assert.equal(panel.InstallCommand.CanExecute(), false)
        assert.equal(panel.SetOwnerPasswordCommand.CanExecute(), false)
        assert.equal(panel.RemoveCommand.CanExecute(), false)
        await panel.Save()
        await panel.Install()
        await panel.SetOwnerPassword()
        assert.deepEqual(fx.Api.ConsoleSaves, [])
        assert.deepEqual(fx.Api.ConsoleInstallStarts, [])
        assert.deepEqual(fx.Api.InHiveOwnerResets, [])
    })
})

describe('Hive tenant console (hive page)', () =>
{
    it('the page loads the console settings and resumes its install', async () =>
    {
        const fx = new ConsoleFixture()
        fx.Api.Hives[0]!.console = { baseDomain: 'example.com', host: 'console.example.com', tls: { source: IngressTlsSource.ExistingSecret, secretName: 'acme-tls' } }
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Installing, ConsoleInstallStep.WaitingForRollout)]
        const detail = await fx.Detail()
        assert.equal(detail.Console.IsConfigured, true)
        assert.equal(detail.Console.Host, 'console.example.com')
        assert.equal(detail.Console.SecretName, 'acme-tls')
        assert.equal(detail.Console.IsExistingSecret, true)
        assert.equal(detail.Console.IsInstalling, true)
        assert.ok(fx.Polls.Pending >= 1)
    })

    it('opening the page of an already reported console schedules no poll', async () =>
    {
        const fx = new ConsoleFixture()
        fx.Api.Hives[0]!.console = { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development } }
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Reported, ConsoleInstallStep.SeedingOwner, { reportedAt: '2026-11-04T10:07:00.000Z' })]
        const detail = await fx.Detail()
        assert.equal(detail.Console.IsReported, true)
        assert.equal(fx.Polls.Pending, 0)
        assert.deepEqual(fx.Polls.Delays, [])
    })

    it('the Owner password is shown once and cleared when the page is left', async () =>
    {
        const fx = new ConsoleFixture()
        fx.Api.Hives[0]!.console = { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development } }
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Deployed, ConsoleInstallStep.SeedingOwner)]
        const detail = await fx.Detail()
        const panel = detail.Console
        assert.equal(panel.IsDeployed, true)
        panel.SetOwnerPasswordCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.InHiveOwnerResets, ['h1'])
        assert.equal(panel.OwnerEmail, 'owner@acme.test')
        assert.equal(panel.OwnerPassword, fx.Api.InHiveOwnerPassword)
        assert.equal(panel.HasOwnerPassword, true)
        fx.Rail.Select(TenantsSectionService)
        await Tick.Settle()
        assert.equal(detail.IsShowing, false)
        assert.equal(panel.OwnerPassword, '')
        assert.equal(panel.OwnerEmail, '')
        assert.equal(panel.HasOwnerPassword, false)
        assert.ok(!Inspect.ReachableStrings(detail, [fx.Api]).includes(fx.Api.InHiveOwnerPassword))
    })

    it('a reset reply that lands after the page was left is kept until the page shows again', async () =>
    {
        const fx = new ConsoleFixture()
        fx.Api.Hives[0]!.console = { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development } }
        const detail = await fx.Detail()
        const panel = detail.Console
        let release: () => void = () => undefined
        const gate = new Promise<void>(resolve => { release = resolve })
        const reset = fx.Api.ResetInHiveOwnerPassword.bind(fx.Api)
        fx.Api.ResetInHiveOwnerPassword = async (hiveId: string) =>
        {
            await gate
            return reset(hiveId)
        }
        panel.SetOwnerPasswordCommand.Execute()
        await Tick.Settle()
        fx.Rail.Select(TenantsSectionService)
        await Tick.Settle()
        release()
        await Tick.Settle()
        assert.equal(panel.OwnerPassword, fx.Api.InHiveOwnerPassword)
        fx.Rail.Select(HivesSectionService)
        await Tick.Settle()
        assert.equal(detail.IsShowing, true)
        assert.equal(panel.OwnerPassword, fx.Api.InHiveOwnerPassword)
        fx.Rail.Select(TenantsSectionService)
        await Tick.Settle()
        assert.equal(panel.OwnerPassword, '')
    })

    it('leaving the page stops the console install polling; coming back resumes it', async () =>
    {
        const fx = new ConsoleFixture()
        fx.Api.Hives[0]!.console = { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development } }
        fx.Api.ConsoleInstallReplies = [FakeControlPlane.ConsoleStatus(ConsoleInstallState.Installing, ConsoleInstallStep.CheckingAgent)]
        const detail = await fx.Detail()
        assert.equal(detail.Console.IsInstalling, true)
        assert.equal(fx.Polls.Pending, 1)
        fx.Rail.Select(TenantsSectionService)
        await Tick.Settle()
        assert.equal(fx.Polls.Pending, 0)
        const reads = fx.Api.ConsoleInstallReads
        fx.Rail.Select(HivesSectionService)
        await Tick.Settle()
        assert.ok(fx.Api.ConsoleInstallReads > reads)
        assert.equal(fx.Polls.Pending, 1)
    })
})
