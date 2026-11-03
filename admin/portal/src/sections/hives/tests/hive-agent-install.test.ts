import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../../../api-client.js'
import { OperatorContext } from '../../../operator-context.js'
import { AgentInstallState, AgentInstallStep } from '../../../portal-types.js'
import { FakeControlPlane, Inspect, PortalTestHost, TestRail, Tick, type FakePollScheduler } from '../../../shell/tests/portal-test-fixtures.js'
import { TenantsSectionService } from '../../tenants/tenants-section-service.js'
import { AgentTokenRevealPageViewModel } from '../agent-token-reveal-page-view-model.js'
import { AgentInstallPhase, AgentInstallStepState, HiveAgentInstallViewModel } from '../hive-agent-install-view-model.js'
import { HiveDetailPageViewModel } from '../hive-detail-page-view-model.js'
import { HivesPageViewModel } from '../hives-page-view-model.js'
import { HivesSectionService } from '../hives-section-service.js'
import { ProvisionInstallPath, ProvisionStep, ProvisionWizardPageViewModel } from '../provision-wizard-page-view-model.js'

// The Hives and Tenants sections behind a real rail, over a fake control plane
// whose bootstrap offers the automatic install, with hand-driven polls.
class AutoFixture
{
    public readonly Api: FakeControlPlane
    public readonly Host: PortalTestHost
    public readonly Polls: FakePollScheduler
    public readonly Rail: TestRail

    public constructor(wireRole: string = OperatorContext.FullWireRole)
    {
        this.Api = new FakeControlPlane()
            .WithClient('acme', 'Acme')
            .WithTenant('acme-prod', 'acme', 'Acme Production')
            .WithHive('acme-hive', 'acme-prod')
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

    public get Section(): HivesSectionService
    {
        return this.Host.Provider.getRequired(HivesSectionService.Key)
    }

    public get Content(): unknown
    {
        return this.Host.Host.Content
    }

    // A bare install panel for the hive.
    public Panel(): HiveAgentInstallViewModel
    {
        return new HiveAgentInstallViewModel(this.Host.Session, 'acme-hive', this.Polls)
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

    // Provisions a new client, tenant and hive and stops on Bootstrap.
    public async Revealed(): Promise<ProvisionWizardPageViewModel>
    {
        this.Rail.Select(HivesSectionService)
        await Tick.Settle()
        assert.ok(this.Content instanceof HivesPageViewModel)
        this.Content.StandUpCommand.Execute()
        await Tick.Settle()
        const wizard: unknown = this.Host.Host.Content
        assert.ok(wizard instanceof ProvisionWizardPageViewModel)
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
        wizard.SubmitCommand.Execute()
        await Tick.Settle()
        assert.equal(wizard.StepIndex, ProvisionStep.Bootstrap)
        return wizard
    }

    // Answers every following read with this status.
    public Reply(state: AgentInstallState, step: AgentInstallStep, error?: string): void
    {
        this.Api.InstallReplies = [FakeControlPlane.InstallStatus(state, step, error)]
    }

    // Lets the queued poll run and its read land.
    public async Poll(): Promise<void>
    {
        this.Polls.RunPending()
        await Tick.Settle()
    }
}

describe('Hive agent automatic install (panel)', () =>
{
    it('Install agent starts it once, shows the running step and polls every 2 seconds until Connected', async () =>
    {
        const fx = new AutoFixture()
        const panel = fx.Panel()
        assert.equal(panel.IsIdle, true)
        assert.equal(panel.HasProgress, false)
        panel.StartCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.InstallStarts, ['acme-hive'])
        assert.equal(panel.Phase, AgentInstallPhase.Installing)
        assert.equal(panel.StartCommand.CanExecute(), false)
        assert.deepEqual(panel.Steps.ToArray().map(s => s.State), [
            AgentInstallStepState.Running, AgentInstallStepState.Pending, AgentInstallStepState.Pending, AgentInstallStepState.Pending, AgentInstallStepState.Pending,
        ])
        assert.deepEqual(fx.Polls.Delays, [2000])
        fx.Reply(AgentInstallState.Installing, AgentInstallStep.StoringToken)
        await fx.Poll()
        assert.deepEqual(panel.Steps.ToArray().map(s => s.StatusLabel), ['Done', 'Done', 'In progress', '', ''])
        assert.equal(fx.Polls.Pending, 1)
        fx.Reply(AgentInstallState.Connected, AgentInstallStep.WaitingForCheckIn)
        await fx.Poll()
        assert.equal(panel.IsConnected, true)
        assert.equal(panel.StatusText, 'Connected. The agent checked in.')
        assert.ok(panel.Steps.ToArray().every(s => s.IsDone))
        assert.equal(fx.Polls.Pending, 0)
        assert.equal(panel.StartCommand.CanExecute(), true)
    })

    it('a failed step shows its error and Retry starts a fresh run', async () =>
    {
        const fx = new AutoFixture()
        const panel = fx.Panel()
        await panel.Start()
        fx.Reply(AgentInstallState.Failed, AgentInstallStep.ApplyingAgent, 'Could not apply the agent to the cluster. kubectl failed: connection refused')
        await fx.Poll()
        assert.equal(panel.IsFailed, true)
        assert.equal(panel.ErrorText, 'Could not apply the agent to the cluster. kubectl failed: connection refused')
        assert.deepEqual(panel.Steps.ToArray().map(s => s.State), [
            AgentInstallStepState.Done, AgentInstallStepState.Failed, AgentInstallStepState.Pending, AgentInstallStepState.Pending, AgentInstallStepState.Pending,
        ])
        assert.equal(fx.Polls.Pending, 0)
        assert.equal(panel.RetryCommand.CanExecute(), true)
        panel.RetryCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.InstallStarts, ['acme-hive', 'acme-hive'])
        assert.equal(panel.IsInstalling, true)
        assert.equal(panel.ErrorText, '')
        assert.equal(panel.Steps.Get(1)?.State, AgentInstallStepState.Pending)
    })

    it('Stop cancels the queued poll and drops a read already in flight', async () =>
    {
        const fx = new AutoFixture()
        const panel = fx.Panel()
        await panel.Start()
        panel.Stop()
        assert.equal(fx.Polls.Pending, 0)
        await panel.Resume()
        assert.equal(fx.Polls.Pending, 0)
        fx.Reply(AgentInstallState.Installing, AgentInstallStep.ApplyingAgent)
        const resumed = panel.Resume()
        panel.Stop()
        await resumed
        assert.equal(fx.Polls.Pending, 0)
    })

    it('Resume with no install leaves the panel idle; with a running one it follows it', async () =>
    {
        const fx = new AutoFixture()
        const panel = fx.Panel()
        await panel.Resume()
        assert.equal(panel.IsIdle, true)
        assert.equal(fx.Polls.Pending, 0)
        fx.Reply(AgentInstallState.Installing, AgentInstallStep.RestartingAgent)
        await panel.Resume()
        assert.equal(panel.IsInstalling, true)
        assert.equal(panel.Steps.Get(3)?.State, AgentInstallStepState.Running)
        assert.equal(fx.Polls.Pending, 1)
    })

    it('a transient read failure keeps polling; a 401 expires the session and stops', async () =>
    {
        const fx = new AutoFixture()
        const panel = fx.Panel()
        await panel.Start()
        fx.Api.InstallReadFailure = new ApiError(502, 'bad gateway')
        await fx.Poll()
        assert.equal(panel.IsInstalling, true)
        assert.equal(fx.Polls.Pending, 1)
        fx.Api.InstallReadFailure = new ApiError(ApiError.UnauthorizedStatus, 'unauthenticated')
        await fx.Poll()
        assert.equal(fx.Host.Reloader.Count, 1)
        assert.equal(fx.Polls.Pending, 0)
    })

    it('a refused start shows its reason, unless an install is already running, which it then follows', async () =>
    {
        const fx = new AutoFixture()
        const panel = fx.Panel()
        fx.Api.StartFailure = new ApiError(409, 'Automatic install is not available for this hive')
        await panel.Start()
        assert.equal(panel.IsFailed, true)
        assert.equal(panel.ErrorText, 'Automatic install is not available for this hive')
        fx.Api.StartFailure = new ApiError(409, 'An agent install is already running for hive acme-hive')
        fx.Reply(AgentInstallState.Installing, AgentInstallStep.ApplyingAgent)
        await panel.Start()
        assert.equal(panel.IsInstalling, true)
        assert.equal(panel.ErrorText, '')
        assert.equal(fx.Polls.Pending, 1)
    })

    it('Observer: Install agent is disabled and never starts', async () =>
    {
        const fx = new AutoFixture(OperatorContext.ReadOnlyWireRole)
        const panel = fx.Panel()
        assert.equal(panel.StartCommand.CanExecute(), false)
        await panel.Start()
        assert.deepEqual(fx.Api.InstallStarts, [])
    })
})

describe('Hive agent automatic install (hive page)', () =>
{
    it('a Local hive offers Install agent, with the manual install behind Install manually', async () =>
    {
        const fx = new AutoFixture()
        const detail = await fx.Detail()
        assert.equal(detail.IsAutoInstall, true)
        assert.equal(detail.IsManualOnly, false)
        assert.equal(detail.ShowsManual, false)
        assert.equal(detail.ManualToggleLabel, 'Install manually')
        detail.ToggleManualCommand.Execute()
        assert.equal(detail.ShowsManual, true)
        assert.equal(detail.ManualToggleLabel, 'Hide manual install')
        detail.AgentInstall.StartCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.InstallStarts, ['acme-hive'])
        assert.equal(detail.AgentInstall.IsInstalling, true)
    })

    it('before the bundle loads the page shows neither path, so a Local hive never flashes the manual install', async () =>
    {
        const fx = new AutoFixture()
        let release: () => void = () => undefined
        const gate = new Promise<void>(resolve => { release = resolve })
        const bootstrap = fx.Api.GetHiveBootstrap.bind(fx.Api)
        fx.Api.GetHiveBootstrap = async (hiveId: string) =>
        {
            await gate
            return bootstrap(hiveId)
        }
        const detail = await fx.Detail()
        assert.equal(detail.IsAutoInstall, false)
        assert.equal(detail.IsManualOnly, false)
        assert.equal(detail.ShowsManual, false)
        const seen: string[] = []
        detail.PropertyChanged('IsAutoInstall').subscribe(e => seen.push('IsAutoInstall=' + String(e.newValue)))
        detail.PropertyChanged('IsManualOnly').subscribe(e => seen.push('IsManualOnly=' + String(e.newValue)))
        release()
        await Tick.Settle()
        assert.equal(detail.IsAutoInstall, true)
        assert.equal(detail.IsManualOnly, false)
        assert.deepEqual(seen, ['IsAutoInstall=true'])
    })

    it('a bundle that failed to load (agent channel off) leaves the manual install, with its reason, showing', async () =>
    {
        const fx = new AutoFixture()
        fx.Api.BootstrapFailure = new ApiError(409, 'The agent channel is not configured')
        const detail = await fx.Detail()
        assert.equal(detail.IsAutoInstall, false)
        assert.equal(detail.IsManualOnly, true)
        assert.equal(detail.ShowsManual, true)
        assert.equal(detail.Install.ErrorText, 'The agent channel is not configured')
    })

    it('Reissue is disabled while an automatic install runs (it would revoke the install\'s token)', async () =>
    {
        const fx = new AutoFixture()
        const detail = await fx.Detail()
        assert.equal(detail.ReissueTokenCommand.CanExecute(), true)
        let raised = 0
        detail.ReissueTokenCommand.AddCanExecuteChangedListener(() => { raised++ })
        await detail.AgentInstall.Start()
        assert.equal(detail.ReissueTokenCommand.CanExecute(), false)
        assert.ok(raised > 0)
        fx.Reply(AgentInstallState.Failed, AgentInstallStep.ApplyingAgent, 'Could not apply the agent to the cluster.')
        await fx.Poll()
        assert.equal(detail.ReissueTokenCommand.CanExecute(), true)
    })

    it('any other hive keeps the manual install only', async () =>
    {
        const fx = new AutoFixture()
        fx.Api.AutoInstall = false
        const detail = await fx.Detail()
        assert.equal(detail.IsAutoInstall, false)
        assert.equal(detail.IsManualOnly, true)
        assert.equal(detail.ShowsManual, true)
        assert.equal(detail.AgentInstall.HasProgress, false)
    })

    it('opening the page resumes a running install; leaving it (another page, another section) stops polling', async () =>
    {
        const fx = new AutoFixture()
        fx.Reply(AgentInstallState.Installing, AgentInstallStep.PreparingCluster)
        const detail = await fx.Detail()
        assert.equal(detail.AgentInstall.IsInstalling, true)
        assert.equal(fx.Polls.Pending, 1)
        // Another page over it: a reissued token's reveal.
        fx.Section.ShowAgentTokenReveal('acme-hive', 'shown-once')
        assert.ok(fx.Content instanceof AgentTokenRevealPageViewModel)
        assert.equal(fx.Polls.Pending, 0)
        assert.equal(detail.IsShowing, false)
    })

    it('switching rail sections stops polling; coming back resumes it', async () =>
    {
        const fx = new AutoFixture()
        fx.Reply(AgentInstallState.Installing, AgentInstallStep.PreparingCluster)
        const detail = await fx.Detail()
        assert.equal(fx.Polls.Pending, 1)
        fx.Rail.Select(TenantsSectionService)
        await Tick.Settle()
        assert.equal(detail.IsShowing, false)
        assert.equal(fx.Polls.Pending, 0)
        const reads = fx.Api.InstallReads
        fx.Rail.Select(HivesSectionService)
        await Tick.Settle()
        assert.equal(detail.IsShowing, true)
        assert.ok(fx.Api.InstallReads > reads)
        assert.equal(fx.Polls.Pending, 1)
    })

    it('opening the page on an already Connected install does not reload it again', async () =>
    {
        const fx = new AutoFixture()
        fx.Reply(AgentInstallState.Connected, AgentInstallStep.WaitingForCheckIn)
        let fleetReads = 0
        const listFleet = fx.Api.ListFleet.bind(fx.Api)
        fx.Api.ListFleet = async () =>
        {
            fleetReads++
            return listFleet()
        }
        const detail = await fx.Detail()
        assert.equal(detail.AgentInstall.IsConnected, true)
        // The hives list and the detail's own first load; no extra reload.
        assert.equal(fleetReads, 2)
    })

    it('when the install connects, the page reloads to show the check-in', async () =>
    {
        const fx = new AutoFixture()
        const detail = await fx.Detail()
        await detail.AgentInstall.Start()
        let fleetReads = 0
        const listFleet = fx.Api.ListFleet.bind(fx.Api)
        fx.Api.ListFleet = async () =>
        {
            fleetReads++
            return listFleet()
        }
        fx.Reply(AgentInstallState.Installing, AgentInstallStep.WaitingForCheckIn)
        await fx.Poll()
        assert.equal(fleetReads, 0)
        fx.Reply(AgentInstallState.Connected, AgentInstallStep.WaitingForCheckIn)
        await fx.Poll()
        assert.equal(detail.AgentInstall.IsConnected, true)
        assert.equal(fleetReads, 1)
    })
})

describe('Hive agent automatic install (stand-up wizard)', () =>
{
    it('a Local hive: the provision token is never shown, the install starts at once and Finish needs only the Owner', async () =>
    {
        const fx = new AutoFixture()
        const wizard = await fx.Revealed()
        assert.equal(wizard.InstallPath, ProvisionInstallPath.Automatic)
        assert.equal(wizard.IsAutomaticInstall, true)
        assert.equal(wizard.AgentToken, '')
        assert.equal(wizard.ShowsAgentToken, false)
        assert.equal(wizard.ShowsInstallPanel, false)
        assert.ok(!Inspect.ReachableStrings(wizard, [fx.Api]).includes(fx.Api.AgentToken))
        assert.deepEqual(fx.Api.InstallStarts, ['initech-hive'])
        assert.equal(wizard.AgentInstall?.IsInstalling, true)
        assert.equal(wizard.FinishCommand.CanExecute(), false)
        wizard.OwnerSaved = true
        assert.equal(wizard.FinishCommand.CanExecute(), true)
        fx.Reply(AgentInstallState.Connected, AgentInstallStep.WaitingForCheckIn)
        await fx.Poll()
        assert.equal(wizard.AgentInstall?.IsConnected, true)
    })

    it('a failed install offers Retry and Install manually, which issues a token shown once', async () =>
    {
        const fx = new AutoFixture()
        const wizard = await fx.Revealed()
        wizard.OwnerSaved = true
        assert.equal(wizard.CanInstallManually, false)
        assert.equal(wizard.ToggleManualCommand.CanExecute(), false)
        fx.Reply(AgentInstallState.Failed, AgentInstallStep.WaitingForCheckIn, 'The agent did not check in in time.')
        await fx.Poll()
        assert.equal(wizard.AgentInstall?.IsFailed, true)
        assert.equal(wizard.AgentInstall?.RetryCommand.CanExecute(), true)
        assert.equal(wizard.CanInstallManually, true)
        wizard.ToggleManualCommand.Execute()
        assert.equal(wizard.ShowsManualInstall, true)
        assert.equal(wizard.ShowsInstallPanel, true)
        assert.ok(wizard.Install.Commands.startsWith('kubectl apply -f bootstrap-initech-hive.json'))
        wizard.IssueManualTokenCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(fx.Api.Reissued, ['initech-hive'])
        assert.equal(wizard.AgentToken, fx.Api.ReissuedToken)
        assert.equal(wizard.ShowsAgentToken, true)
        assert.equal(wizard.HasPendingSecret, true)
        assert.equal(wizard.IssueManualTokenCommand.CanExecute(), false)
        assert.equal(wizard.FinishCommand.CanExecute(), false)
        wizard.AgentSaved = true
        assert.equal(wizard.FinishCommand.CanExecute(), true)
    })

    it('Retry after a manual token was issued drops that token: the install replaces it with its own', async () =>
    {
        const fx = new AutoFixture()
        const wizard = await fx.Revealed()
        wizard.OwnerSaved = true
        fx.Reply(AgentInstallState.Failed, AgentInstallStep.ApplyingAgent, 'Could not apply the agent to the cluster.')
        await fx.Poll()
        wizard.ToggleManualCommand.Execute()
        wizard.IssueManualTokenCommand.Execute()
        await Tick.Settle()
        assert.equal(wizard.AgentToken, fx.Api.ReissuedToken)
        wizard.AgentInstall?.RetryCommand.Execute()
        await Tick.Settle()
        assert.equal(wizard.AgentInstall?.IsInstalling, true)
        assert.equal(wizard.AgentToken, '')
        assert.equal(wizard.ShowsAgentToken, false)
        assert.equal(wizard.CanInstallManually, false)
        assert.equal(wizard.FinishCommand.CanExecute(), true)
    })

    it('a wizard install replaced by a newer one stops polling', async () =>
    {
        const fx = new AutoFixture()
        const wizard = await fx.Revealed()
        const first = wizard.AgentInstall
        assert.equal(fx.Polls.Pending, 1)
        // ChooseInstallPath runs again (as a second provision on the same page would).
        await (wizard as unknown as { ChooseInstallPath(id: string): Promise<void> }).ChooseInstallPath('initech-hive')
        assert.notEqual(wizard.AgentInstall, first)
        assert.equal(fx.Polls.Pending, 1)
        fx.Reply(AgentInstallState.Installing, AgentInstallStep.ApplyingAgent)
        await fx.Poll()
        assert.equal(first?.Steps.Get(1)?.IsRunning, false)
    })

    it('Finish leaves the wizard and its polling stops', async () =>
    {
        const fx = new AutoFixture()
        const wizard = await fx.Revealed()
        assert.equal(fx.Polls.Pending, 1)
        wizard.OwnerSaved = true
        wizard.FinishCommand.Execute()
        await Tick.Settle()
        assert.ok(fx.Content instanceof HiveDetailPageViewModel)
        assert.equal(wizard.IsShowing, false)
        assert.equal(fx.Polls.Pending, 0)
    })

    it('a hive the control plane does not install keeps the manual path with the token', async () =>
    {
        const fx = new AutoFixture()
        fx.Api.AutoInstall = false
        const wizard = await fx.Revealed()
        assert.equal(wizard.InstallPath, ProvisionInstallPath.Manual)
        assert.equal(wizard.AgentToken, fx.Api.AgentToken)
        assert.equal(wizard.ShowsAgentToken, true)
        assert.equal(wizard.ShowsInstallPanel, true)
        assert.equal(wizard.AgentInstall, undefined)
        assert.deepEqual(fx.Api.InstallStarts, [])
    })
})
