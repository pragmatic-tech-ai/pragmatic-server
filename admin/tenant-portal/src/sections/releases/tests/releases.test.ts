import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import { TenantApiError } from '../../../tenant-api-client.js'
import { EnvStatus } from '../../../tenant-types.js'
import { PageState, TenantPageViewModel } from '../../../shell/tenant-page-view-model.js'
import { TenantSectionService } from '../../../shell/tenant-section-service.js'
import type { TenantSessionService } from '../../../shell/tenant-session-service.js'
import { FakeTenantApi, TenantTestHost, TestRail, Tick } from '../../../shell/tests/tenant-test-fixtures.js'
import { EnvironmentsSectionService } from '../../environments/environments-section-service.js'
import { AdoptOutcome, AdoptStep, AdoptWizardPageViewModel } from '../adopt-wizard-page-view-model.js'
import { ReleasesPageViewModel } from '../releases-page-view-model.js'
import { ReleasesSectionService } from '../releases-section-service.js'
import { ReleasesSnapshot } from '../releases-snapshot.js'

// A root page that loads nothing.
class BlankPage extends TenantPageViewModel
{
    public constructor(session: TenantSessionService)
    {
        super(session)
    }

    protected override async LoadCore(): Promise<boolean>
    {
        return true
    }
}

// Stands in for the Environments section (registered under its key), so these
// tests do not depend on that section's pages.
class StubEnvironmentsSection extends TenantSectionService
{
    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    protected override CreateRoot(): TenantPageViewModel
    {
        return new BlankPage(this.Session)
    }
}

class Fixture
{
    public readonly Api: FakeTenantApi
    public readonly Host: TenantTestHost
    public readonly Rail: TestRail

    public constructor(api: FakeTenantApi = Fixture.StandardApi(), capabilities = TenantTestHost.AllCapabilities)
    {
        this.Api = api
        this.Host = new TenantTestHost(api, capabilities)
        this.Host.Provider.register(ReleasesSectionService.Key, (p) => new ReleasesSectionService(p))
        this.Host.Provider.register(EnvironmentsSectionService.Key, (p) => new StubEnvironmentsSection(p) as unknown as EnvironmentsSectionService)
        this.Rail = new TestRail(this.Host.Provider)
        this.Rail.Add(EnvironmentsSectionService.Key)
        this.Rail.Add(ReleasesSectionService.Key)
    }

    // Versions 1 (current, the target), 2 (offered) and 3 (withdrawn);
    // alpha runs 1, bravo (stopped) runs 1.
    public static StandardApi(): FakeTenantApi
    {
        const api = new FakeTenantApi()
            .WithManifest('1', 'reg/app:1')
            .WithManifest('2', 'reg/app:2', { notes: 'Faster maps' })
            .WithManifest('3', 'reg/app:3', { withdrawn: true })
            .WithEnvironment('alpha', EnvStatus.Running, 'hive-1', 'reg/app:1')
            .WithEnvironment('bravo', EnvStatus.Stopped, 'hive-1', 'reg/app:1')
        api.Rollout.targetVersion = '1'
        return api
    }

    public get Section(): ReleasesSectionService
    {
        return this.Host.Provider.getRequired(ReleasesSectionService.Key)
    }

    public get Navigation(): NavigationService
    {
        return this.Host.Provider.getRequired(NavigationService.Key)
    }

    public get Content(): unknown
    {
        return this.Host.Host.Content
    }

    public async OpenReleases(): Promise<ReleasesPageViewModel>
    {
        this.Rail.Select(ReleasesSectionService.Key)
        await Tick.Settle()
        return this.Content as ReleasesPageViewModel
    }

    public async OpenWizard(version?: string): Promise<AdoptWizardPageViewModel>
    {
        this.Section.OpenAdopt(version)
        await Tick.Settle()
        return this.Content as AdoptWizardPageViewModel
    }
}

describe('ReleasesSnapshot', () =>
{
    it('resolves the current version: target wins, a unanimous image resolves, mixed is none', () =>
    {
        const manifests = [
            { id: '1', image: 'i:1', publishedAt: '2026-10-01T00:00:00Z' },
            { id: '2', image: 'i:2', publishedAt: '2026-10-02T00:00:00Z' },
        ]
        const env = (name: string, image: string) => ({ environmentName: name, runningImage: image, obsolete: false, ready: true })
        assert.equal(ReleasesSnapshot.From(manifests, { targetVersion: '2', environments: [env('a', 'i:1')] }, [], []).CurrentVersion, '2')
        assert.equal(ReleasesSnapshot.From(manifests, { targetVersion: undefined, environments: [env('a', 'i:1'), env('b', 'i:1')] }, [], []).CurrentVersion, '1')
        assert.equal(ReleasesSnapshot.From(manifests, { targetVersion: undefined, environments: [env('a', 'i:1'), env('b', 'i:2')] }, [], []).CurrentVersion, undefined)
    })
})

describe('ReleasesPageViewModel', () =>
{
    it('offers every non-withdrawn, non-current version with how many environments are not on it', async () =>
    {
        const f = new Fixture()
        const page = await f.OpenReleases()
        assert.equal(page.State, PageState.Populated)
        const offers = page.Offers.ToArray()
        assert.deepEqual(offers.map(o => o.Version), ['2'])
        assert.equal(offers[0]?.NotOnText, '2 environments not on this version.')
        assert.equal(offers[0]?.Notes, 'Faster maps')
        assert.equal(offers[0]?.PublishedText, 'Published 2026-10-02')
        assert.deepEqual(f.Api.Calls.filter(c => c[0] === 'GetRollout' || c[0] === 'ListLedger'), [['GetRollout', 'hive-1'], ['ListLedger', 'hive-1']])
    })

    it('says when every environment is already on an offered version', async () =>
    {
        const api = new FakeTenantApi()
            .WithManifest('1', 'reg/app:1')
            .WithManifest('2', 'reg/app:2')
            .WithEnvironment('alpha', EnvStatus.Running, 'hive-1', 'reg/app:1')
        api.Rollout.targetVersion = '2'
        const page = await new Fixture(api).OpenReleases()
        assert.equal(page.Offers.ToArray()[0]?.NotOnText, 'All environments are on this version.')
    })

    it('builds the environment x version matrix with fixed-order cells and the current version marked', async () =>
    {
        const page = await new Fixture().OpenReleases()
        assert.deepEqual(page.MatrixHeader.ToArray().map(h => h.Label), ['3', '2', '1 (current)'])
        assert.equal(page.HasMatrix, true)
        const rows = page.MatrixRows.ToArray()
        assert.deepEqual(rows.map(r => r.Name), ['alpha', 'bravo'])
        const dash = String.fromCharCode(0x2014)
        assert.deepEqual(rows[0]?.Cells.ToArray().map(c => c.Text), [dash, dash, 'Running'])
        assert.deepEqual(rows[0]?.Cells.ToArray().map(c => c.IsRunning), [false, false, true])
    })

    it('labels the version history and renders its times in UTC', async () =>
    {
        const api = Fixture.StandardApi()
        api.Ledger = [
            { version: '2', action: 'selected', at: '2026-10-05T09:07:00.000Z' },
            { version: '2', action: 'adopted', at: '2026-10-05T09:08:00.000Z' },
            { version: '3', action: 'withdrawn', at: 'not a date' },
            { version: '1', action: 'gated', at: '2026-10-01T00:00:00.000Z' },
            { version: '1', action: 'ungated', at: '2026-10-01T00:00:00.000Z' },
            { version: '1', action: 'restored', at: '2026-10-01T00:00:00.000Z' },
            { version: '1', action: 'mystery', at: '2026-10-01T00:00:00.000Z' },
        ]
        const page = await new Fixture(api).OpenReleases()
        const rows = page.LedgerRows.ToArray()
        assert.deepEqual(rows.map(r => r.ActionLabel), ['Selected as target', 'Adopted', 'Withdrawn', 'Gated', 'Ungated', 'Restored', 'mystery'])
        assert.equal(rows[0]?.WhenLabel, '2026-10-05 09:07 UTC')
        assert.equal(rows[2]?.WhenLabel, 'not a date')
        assert.equal(page.HasLedger, true)
    })

    it('has no history rows for an empty ledger', async () =>
    {
        const page = await new Fixture().OpenReleases()
        assert.equal(page.HasNoLedger, true)
    })

    it('is Empty with its own text when nothing is offered, and when there is no hive', async () =>
    {
        const api = new FakeTenantApi().WithManifest('1', 'reg/app:1').WithEnvironment('alpha', EnvStatus.Running, 'hive-1', 'reg/app:1')
        api.Rollout.targetVersion = '1'
        const page = await new Fixture(api).OpenReleases()
        assert.equal(page.State, PageState.Empty)
        assert.match(page.EmptyText, /^No new versions offered\./)
        const noHive = new FakeTenantApi()
        const host = new TenantTestHost(noHive, null)
        const bare = new ReleasesPageViewModel(host.Session, { OpenAdopt: () => assert.fail('no navigation') })
        await bare.Refresh()
        assert.equal(bare.State, PageState.Empty)
        assert.match(bare.EmptyText, /^No hive yet\./)
    })

    it('shows a load failure as Error and a 401 expires the session', async () =>
    {
        const api = Fixture.StandardApi()
        api.FailOn.set('ListLedger', new TenantApiError(500, 'ledger down'))
        const page = await new Fixture(api).OpenReleases()
        assert.equal(page.State, PageState.Error)
        assert.equal(page.ErrorText, 'ledger down')
        const expired = Fixture.StandardApi()
        expired.FailOn.set('ListManifests', new TenantApiError(401, 'gone'))
        const f = new Fixture(expired)
        await f.OpenReleases()
        assert.equal(f.Host.Reloader.Count, 1)
    })

    it('Adopt... opens the wizard for that version', async () =>
    {
        const f = new Fixture()
        const page = await f.OpenReleases()
        const offer = page.Offers.ToArray()[0]!
        assert.equal(offer.AdoptCommand.CanExecute(), true)
        offer.AdoptCommand.Execute()
        await Tick.Settle()
        const wizard = f.Content
        assert.ok(wizard instanceof AdoptWizardPageViewModel)
        assert.equal(wizard.SelectedVersion?.Value, '2')
    })

    it('without the Adopt versions permission, Adopt... is disabled with the reason shown and opens nothing', async () =>
    {
        const f = new Fixture(Fixture.StandardApi(), { ...TenantTestHost.AllCapabilities, adopt: false })
        const page = await f.OpenReleases()
        const offer = page.Offers.ToArray()[0]!
        assert.equal(offer.AdoptCommand.CanExecute(), false)
        assert.equal(page.AdoptCommand.CanExecute('2'), false)
        assert.match(page.DeniedReason, /Adopt versions permission/)
        offer.AdoptCommand.Execute()
        page.AdoptCommand.Execute('2')
        await Tick.Settle()
        assert.equal(f.Content, page)
    })
})

describe('ReleasesSectionService.OpenAdopt', () =>
{
    it('brings Releases to the front on the wizard with the version preselected', async () =>
    {
        const api = Fixture.StandardApi().WithManifest('4', 'reg/app:4')
        const f = new Fixture(api)
        f.Rail.Select(EnvironmentsSectionService.Key)
        await Tick.Settle()
        const wizard = await f.OpenWizard('2')
        assert.equal(f.Navigation.ActiveService, f.Section)
        assert.ok(wizard instanceof AdoptWizardPageViewModel)
        assert.equal(wizard.State, PageState.Populated)
        assert.deepEqual(wizard.Versions.ToArray().map(v => v.Value), ['4', '2'])
        assert.equal(wizard.SelectedVersion?.Value, '2')
        f.Section.Back()
        assert.ok(f.Content instanceof ReleasesPageViewModel)
    })

    it('without a version preselects the newest offer', async () =>
    {
        const f = new Fixture(Fixture.StandardApi().WithManifest('4', 'reg/app:4'))
        const wizard = await f.OpenWizard()
        assert.equal(wizard.SelectedVersion?.Value, '4')
    })

    it('lands on a wizard already past its Version step instead of replacing it', async () =>
    {
        const f = new Fixture(Fixture.StandardApi().WithManifest('4', 'reg/app:4'))
        const wizard = await f.OpenWizard('2')
        wizard.NextCommand.Execute()
        assert.equal(wizard.HasPendingWork, true)
        await f.OpenWizard('4')
        assert.equal(f.Content, wizard)
        assert.equal(wizard.SelectedVersion?.Value, '2')
    })
})

describe('AdoptWizardPageViewModel', () =>
{
    it('walks Version, Environments, Review with Back, and only Review can adopt', async () =>
    {
        const f = new Fixture()
        const wizard = await f.OpenWizard('2')
        assert.equal(wizard.StepIndex, AdoptStep.Version)
        assert.deepEqual(wizard.Steps.ToArray().map(s => [s.Label, s.IsCurrent]), [['Version', true], ['Environments', false], ['Review', false], ['Outcome', false]])
        assert.equal(wizard.BackStepCommand.CanExecute(), false)
        assert.equal(wizard.AdoptCommand.CanExecute(), false)
        assert.equal(wizard.HasPendingWork, false)
        wizard.NextCommand.Execute()
        assert.equal(wizard.StepIndex, AdoptStep.Environments)
        assert.equal(wizard.Steps.ToArray()[1]?.IsCurrent, true)
        assert.deepEqual(wizard.Environments.ToArray().map(e => [e.Name, e.Label]), [
            ['alpha', 'Will restart'],
            ['bravo', 'Starts on this version when next started'],
        ])
        // The version is fixed once past the Version step.
        const kept: AdoptWizardPageViewModel = wizard
        kept.SelectedVersion = undefined
        assert.equal(wizard.SelectedVersion?.Value, '2')
        wizard.NextCommand.Execute()
        assert.equal(wizard.StepIndex, AdoptStep.Review)
        assert.equal(wizard.NextCommand.CanExecute(), false)
        assert.equal(wizard.AdoptLabel, 'Adopt 2')
        assert.equal(wizard.ImpactText, 'Rolling to 2 restarts: alpha, bravo')
        assert.equal(wizard.AdoptCommand.CanExecute(), true)
        wizard.BackStepCommand.Execute()
        assert.equal(wizard.StepIndex, AdoptStep.Environments)
        assert.equal(wizard.AdoptCommand.CanExecute(), false)
    })

    it('marks an environment already on the version', async () =>
    {
        const api = Fixture.StandardApi().WithEnvironment('charlie', EnvStatus.Running, 'hive-1', 'reg/app:2')
        const wizard = await new Fixture(api).OpenWizard('2')
        assert.equal(wizard.Environments.ToArray().find(e => e.Name === 'charlie')?.Label, 'Already on this version')
    })

    it('needs a version to go on', async () =>
    {
        const wizard = await new Fixture().OpenWizard('2')
        wizard.SelectedVersion = undefined
        assert.equal(wizard.NextCommand.CanExecute(), false)
        wizard.NextCommand.Execute()
        assert.equal(wizard.StepIndex, AdoptStep.Version)
    })

    it('is Empty when nothing is offered', async () =>
    {
        const api = new FakeTenantApi().WithManifest('1', 'reg/app:1')
        api.Rollout.targetVersion = '1'
        const wizard = await new Fixture(api).OpenWizard()
        assert.equal(wizard.State, PageState.Empty)
        assert.equal(wizard.EmptyText, 'No versions are offered to your hive right now.')
    })

    it('calls SelectTarget exactly once even when Adopt runs twice, and reports success', async () =>
    {
        const f = new Fixture()
        const wizard = await f.OpenWizard('2')
        wizard.NextCommand.Execute()
        wizard.NextCommand.Execute()
        wizard.AdoptCommand.Execute()
        wizard.AdoptCommand.Execute()
        await Tick.Settle()
        wizard.AdoptCommand.Execute()
        await Tick.Settle()
        assert.equal(f.Api.Count('SelectTarget'), 1)
        assert.deepEqual(f.Api.Calls.find(c => c[0] === 'SelectTarget'), ['SelectTarget', 'hive-1', '2'])
        assert.equal(wizard.StepIndex, AdoptStep.Outcome)
        assert.equal(wizard.Outcome, AdoptOutcome.Adopted)
        assert.equal(wizard.OutcomeTitle, 'Adopted: the hive now targets this version.')
        assert.equal(wizard.OutcomeMessage, '')
        assert.equal(wizard.HasPendingWork, false)
        // A later reload keeps the Outcome (the adopted version is no longer offered).
        await wizard.Refresh()
        assert.equal(wizard.State, PageState.Populated)
        assert.equal(wizard.StepIndex, AdoptStep.Outcome)
    })

    for (const [status, title, outcome] of [
        [409, 'Adopt was refused.', AdoptOutcome.Refused],
        [503, 'Adopt is unavailable right now.', AdoptOutcome.Unavailable],
        [500, 'The adopt could not be completed.', AdoptOutcome.Failed],
    ] as const)
    {
        it('reports a ' + String(status) + ' as "' + title + '" with the server message', async () =>
        {
            const api = Fixture.StandardApi()
            api.FailOn.set('SelectTarget', new TenantApiError(status, 'server says ' + String(status)))
            const wizard = await new Fixture(api).OpenWizard('2')
            wizard.NextCommand.Execute()
            wizard.NextCommand.Execute()
            wizard.AdoptCommand.Execute()
            await Tick.Settle()
            assert.equal(wizard.Outcome, outcome)
            assert.equal(wizard.OutcomeTitle, title)
            assert.equal(wizard.OutcomeMessage, 'server says ' + String(status))
            assert.equal(wizard.IsNotAdopted, true)
            assert.equal(api.Rollout.targetVersion, '1')
        })
    }

    it('a 401 on adopt expires the session', async () =>
    {
        const api = Fixture.StandardApi()
        api.FailOn.set('SelectTarget', new TenantApiError(401, 'gone'))
        const f = new Fixture(api)
        const wizard = await f.OpenWizard('2')
        wizard.NextCommand.Execute()
        wizard.NextCommand.Execute()
        wizard.AdoptCommand.Execute()
        await Tick.Settle()
        assert.equal(f.Host.Reloader.Count, 1)
    })

    it('without the Adopt versions permission the Adopt is disabled with the reason and never selects', async () =>
    {
        const f = new Fixture(Fixture.StandardApi(), { ...TenantTestHost.AllCapabilities, adopt: false })
        const wizard = await f.OpenWizard('2')
        wizard.NextCommand.Execute()
        wizard.NextCommand.Execute()
        assert.equal(wizard.AdoptCommand.CanExecute(), false)
        assert.match(wizard.DeniedReason, /Adopt versions permission/)
        wizard.AdoptCommand.Execute()
        await Tick.Settle()
        assert.equal(f.Api.Count('SelectTarget'), 0)
        assert.equal(wizard.StepIndex, AdoptStep.Review)
    })

    it('Back to releases returns to a reloaded Releases page', async () =>
    {
        const f = new Fixture()
        const wizard = await f.OpenWizard('2')
        wizard.NextCommand.Execute()
        wizard.NextCommand.Execute()
        wizard.AdoptCommand.Execute()
        await Tick.Settle()
        const manifestsBefore = f.Api.Count('ListManifests')
        wizard.BackToReleasesCommand.Execute()
        await Tick.Settle()
        const page = f.Content
        assert.ok(page instanceof ReleasesPageViewModel)
        assert.ok(f.Api.Count('ListManifests') > manifestsBefore)
        assert.deepEqual(page.MatrixHeader.ToArray().map(h => h.Label), ['3', '2 (current)', '1'])
    })

    it('Back to environments leaves the wizard and brings Environments to the front', async () =>
    {
        const f = new Fixture()
        const wizard = await f.OpenWizard('2')
        wizard.NextCommand.Execute()
        wizard.NextCommand.Execute()
        wizard.AdoptCommand.Execute()
        await Tick.Settle()
        wizard.BackToEnvironmentsCommand.Execute()
        await Tick.Settle()
        assert.equal(f.Navigation.ActiveService, f.Host.Provider.getRequired(EnvironmentsSectionService.Key))
        assert.ok(f.Section.Current instanceof ReleasesPageViewModel)
    })

    it('Cancel returns to the Releases page without adopting', async () =>
    {
        const f = new Fixture()
        const wizard = await f.OpenWizard('2')
        wizard.NextCommand.Execute()
        wizard.CancelCommand.Execute()
        await Tick.Settle()
        assert.ok(f.Content instanceof ReleasesPageViewModel)
        assert.equal(f.Api.Count('SelectTarget'), 0)
    })
})
