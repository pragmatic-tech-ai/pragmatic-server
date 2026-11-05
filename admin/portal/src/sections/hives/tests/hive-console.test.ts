import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../../../api-client.js'
import { OperatorContext } from '../../../operator-context.js'
import { ConsoleInstallState, ConsoleInstallStep, IngressTlsSource } from '../../../portal-types.js'
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

    public constructor(wireRole: string = OperatorContext.FullWireRole)
    {
        this.Api = new FakeControlPlane()
            .WithClient('acme-co', 'Acme')
            .WithTenant('acme', 'acme-co', 'Acme')
            .WithHive('h1', 'acme')
        this.Api.AutoInstall = true
        this.Host = new PortalTestHost(this.Api.AsClient(), wireRole)
        this.Host.UseDialogs()
        this.Host.UseClipboard()
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

    // A bare console panel for h1, loaded with its record.
    public Panel(): HiveConsoleViewModel
    {
        const panel = new HiveConsoleViewModel(this.Host.Session, 'h1', this.Polls)
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
        assert.equal(panel.SetOwnerPasswordCommand.CanExecute(), false)
        panel.InstallCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.ConsoleInstallStarts, ['h1'])
        assert.equal(panel.IsInstalling, true)
        assert.equal(panel.InstallCommand.CanExecute(), false)
        assert.equal(panel.SaveCommand.CanExecute(), false)
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
        assert.equal(fx.Polls.Pending, 0)
        assert.equal(panel.SetOwnerPasswordCommand.CanExecute(), true)
        assert.equal(panel.InstallCommand.CanExecute(), true)
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
