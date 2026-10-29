import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import type { ControlPlaneClient } from '../src/api-client.js'
import { GatingMode, ReleasePolicyView } from '../src/release-policy-view.js'
import { OperatorContext } from '../src/operator-context.js'
import { Act, Banner, KeyActivatedButton, ErrorStatePanel, PageHeader, ScreenState, Section } from '../src/kit/index.js'
import type { ClientDto, FleetHiveDto, GatingDto, HiveRolloutDto, ManifestDto, PolicyDto, SelectionDto, TenantDto } from '../src/portal-types.js'

class FakeClient
{
    public Calls = 0
    public Gated: string[][] = []
    public Ungated: string[][] = []
    public FailGate = false
    public Policies: PolicyDto[] = []
    public Manifests: ManifestDto[] = []
    public PolicyCalls: unknown[][] = []
    public ListPoliciesCalls = 0

    public constructor(
        private readonly gating: GatingDto[],
        private readonly selections: SelectionDto[],
        private readonly tenants: TenantDto[],
        private readonly clients: ClientDto[],
        private readonly fleet: FleetHiveDto[],
        public FailFirst = false,
        private readonly rollouts: HiveRolloutDto[] = [])
    {
    }

    public ListGating(): Promise<GatingDto[]>
    {
        this.Calls++
        if (this.FailFirst && this.Calls === 1)
        {
            return Promise.reject(new Error('boom'))
        }
        return Promise.resolve(this.gating)
    }

    public Gate(t: string, v: string): Promise<void>
    {
        if (this.FailGate)
        {
            return Promise.reject(new Error('no'))
        }
        this.Gated.push([t, v])
        return Promise.resolve()
    }

    public Ungate(t: string, v: string): Promise<void>
    {
        if (this.FailGate)
        {
            return Promise.reject(new Error('no'))
        }
        this.Ungated.push([t, v])
        return Promise.resolve()
    }

    public ListPolicies(): Promise<PolicyDto[]>
    {
        this.ListPoliciesCalls++
        return Promise.resolve(this.Policies)
    }

    public ListManifests(): Promise<ManifestDto[]>
    {
        return Promise.resolve(this.Manifests)
    }

    public SetTenantChannels(t: string, channels: string[]): Promise<void>
    {
        this.PolicyCalls.push(['channels', t, channels])
        return Promise.resolve()
    }

    public SetTenantMinVersion(t: string, v: string): Promise<void>
    {
        this.PolicyCalls.push(['minVersion', t, v])
        return Promise.resolve()
    }

    public ClearTenantMinVersion(t: string): Promise<void>
    {
        this.PolicyCalls.push(['clearMinVersion', t])
        return Promise.resolve()
    }

    public SetTenantHold(t: string, reason: string): Promise<void>
    {
        this.PolicyCalls.push(['hold', t, reason])
        return Promise.resolve()
    }

    public ClearTenantHold(t: string): Promise<void>
    {
        this.PolicyCalls.push(['clearHold', t])
        return Promise.resolve()
    }

    public ListSelections(): Promise<SelectionDto[]>
    {
        return Promise.resolve(this.selections)
    }

    public ListTenants(): Promise<TenantDto[]>
    {
        return Promise.resolve(this.tenants)
    }

    public ListClients(): Promise<ClientDto[]>
    {
        return Promise.resolve(this.clients)
    }

    public ListRollouts(): Promise<HiveRolloutDto[]>
    {
        return Promise.resolve(this.rollouts)
    }

    public ListFleet(): Promise<FleetHiveDto[]>
    {
        return Promise.resolve(this.fleet)
    }
}

class Fixtures
{
    public static Walk(root: unknown): unknown[]
    {
        const out: unknown[] = [root]
        const children = (root as { Children?: Iterable<unknown> }).Children
        for (const c of children ?? [])
        {
            out.push(...Fixtures.Walk(c))
        }
        return out
    }

    public static Tenant(): TenantDto
    {
        return { id: 't1', displayName: 'Tenant One', clientId: 'c1' } as unknown as TenantDto
    }

    public static Client(): ClientDto
    {
        return { id: 'c1', displayName: 'Client One' } as unknown as ClientDto
    }

    public static Hive(id: string): FleetHiveDto
    {
        return {
            id,
            displayName: 'Hive ' + id,
            tenant: { id: 't1', displayName: 'Tenant One' },
            client: { id: 'c1', displayName: 'Client One' },
            clusterBackend: 'k8s',
            clusterMode: 'single',
            lastSeen: null,
            environments: [],
        }
    }

    public static Rollouts(): HiveRolloutDto[]
    {
        return [{ hiveId: 'h1', targetVersion: '2.0', environments: [{ environmentName: 'prod', runningImage: 'img:1', obsolete: true, ready: true }] }]
    }

    public static Populated(failFirst = false): FakeClient
    {
        return new FakeClient(
            [{ tenantId: 't1', version: '1.0', gatedAt: '2026-01-02T03:04:05Z' }],
            [{ hiveId: 'h1', targetVersion: '1.0', selectedAt: '2026-01-02T03:04:05Z' }],
            [Fixtures.Tenant()], [Fixtures.Client()], [Fixtures.Hive('h1')], failFirst, Fixtures.Rollouts())
    }

    public static View(client: FakeClient, wire = 'full'): ReleasePolicyView
    {
        return new ReleasePolicyView(client as unknown as ControlPlaneClient, OperatorContext.FromWire(wire))
    }

    public static FormBoxes(view: unknown): TextBox[]
    {
        const forms = ['Tenant id', 'Version']
        return Fixtures.Walk(view).filter(n => n instanceof TextBox && forms.includes(n.Placeholder)) as TextBox[]
    }

    public static Box(view: unknown, placeholder: string): TextBox
    {
        return Fixtures.Walk(view).find(n => n instanceof TextBox && n.Placeholder === placeholder) as TextBox
    }

    public static Texts(view: unknown): string[]
    {
        return Fixtures.Walk(view).filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
    }

    public static Toggle(view: unknown, text: string): KeyActivatedButton
    {
        return Fixtures.Walk(view).find(n => n instanceof KeyActivatedButton && !(n instanceof Act)
            && (n.Content as TextBlock | undefined)?.Text?.endsWith(text)) as KeyActivatedButton
    }

    public static Cancel(view: unknown): void
    {
        const btn = Fixtures.Walk(view).find(n => n instanceof KeyActivatedButton && !(n instanceof Act)
            && (n.Content as TextBlock | undefined)?.Text === 'Cancel') as KeyActivatedButton
        btn.Press()
    }

    public static LastActByLabel(view: unknown, label: string): Act
    {
        const acts = Fixtures.Walk(view).filter(n => n instanceof Act && (n.Content as TextBlock).Text === label)
        return acts[acts.length - 1] as Act
    }

    public static ActByLabel(view: unknown, label: string): Act
    {
        return Fixtures.Walk(view).find(n => n instanceof Act && (n.Content as TextBlock).Text === label) as Act
    }
}

describe('ReleasePolicyView', () =>
{
    let previous: Application | null

    before(() =>
    {
        previous = Application.current
        const app = new Application()
        Application.current = app
        app.initialize({ theme: Pragmatic, scheme: PragmaticLight })
    })

    after(() =>
    {
        Application.current = previous
    })

    it('is populated with both tables, the info banner and the page header', async () =>
    {
        const view = Fixtures.View(Fixtures.Populated())
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.GatedTable?.Rows.length, 1)
        assert.equal(view.TargetTable?.Rows.length, 1)
        const nodes = Fixtures.Walk(view)
        const banner = nodes.find(n => n instanceof Banner) as Banner
        assert.ok(banner)
        assert.ok(banner.Text.startsWith('This is the current gating and selection model'))
        const header = nodes.find(n => n instanceof PageHeader) as PageHeader
        assert.equal(header.Title, 'Release Policy')
    })

    it('is empty for an observer when all five lists are empty', async () =>
    {
        const view = Fixtures.View(new FakeClient([], [], [], [], []), 'read')
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Empty)
        assert.equal(view.GatedTable, undefined)
        assert.equal(view.TargetTable, undefined)
    })

    it('shows the error state and onRetry recovers', async () =>
    {
        const view = Fixtures.View(Fixtures.Populated(true))
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Error)
        const panel = Fixtures.Walk(view).find(n => n instanceof ErrorStatePanel) as ErrorStatePanel
        assert.ok(panel)
        panel.RetryButton.Press()
        await new Promise(r => setTimeout(r, 0))
        assert.equal(view.Host.State, ScreenState.Populated)
    })

    it('keeps a selection for a hive missing from the fleet', async () =>
    {
        const client = new FakeClient([], [{ hiveId: 'ghost', targetVersion: '2.0', selectedAt: '2026-01-02T03:04:05Z' }], [], [], [])
        const view = Fixtures.View(client)
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.TargetTable?.Rows.length, 1)
        const texts = Fixtures.Walk(view.TargetTable).filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
        assert.ok(texts.includes('(unknown hive)'))
    })

    it('survives a second Refresh', async () =>
    {
        const view = Fixtures.View(Fixtures.Populated())
        await view.Refresh()
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.GatedTable?.Rows.length, 1)
        assert.equal(view.TargetTable?.Rows.length, 1)
    })

    it('surfaces no fabricated fields or controls', async () =>
    {
        const view = Fixtures.View(Fixtures.Populated())
        await view.Refresh()
        const banned = ['ledger', ' rule', 'scoped']
        const texts = Fixtures.Walk(view)
            .filter(n => n instanceof TextBlock)
            .map(n => (n as TextBlock).Text.toLowerCase())
            // The explanatory note legitimately names what is NOT available.
            .filter(t => !t.startsWith('this is the current gating'))
        for (const t of texts)
        {
            for (const b of banned)
            {
                assert.ok(!t.includes(b), 'unexpected text: ' + t)
            }
        }
    })

    it('renders a Rollout status section whose rows and status text come from the model', async () =>
    {
        const view = Fixtures.View(Fixtures.Populated())
        await view.Refresh()
        assert.equal(view.RolloutTable?.Rows.length, 1)
        const texts = Fixtures.Walk(view.RolloutTable).filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
        assert.ok(texts.includes('Behind target'))
        assert.ok(texts.includes('prod'))
        const titles = Fixtures.Walk(view).filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
        assert.ok(titles.includes('Rollout status'))
    })

    it('is not empty when only rollout rows exist', async () =>
    {
        const view = Fixtures.View(new FakeClient([], [], [], [], [], false, Fixtures.Rollouts()))
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.RolloutTable?.Rows.length, 1)
    })

    it('re-renders all three sections on a second Refresh', async () =>
    {
        const view = Fixtures.View(Fixtures.Populated())
        await view.Refresh()
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.GatedTable?.Rows.length, 1)
        assert.equal(view.TargetTable?.Rows.length, 1)
        assert.equal(view.RolloutTable?.Rows.length, 1)
        assert.equal(Fixtures.Walk(view).filter(n => n instanceof Section).length, 4)
    })

    it('renders Gate version and Ungate version actions', async () =>
    {
        const view = Fixtures.View(Fixtures.Populated())
        await view.Refresh()
        assert.ok(Fixtures.ActByLabel(view, 'Gate version'))
        assert.ok(Fixtures.ActByLabel(view, 'Ungate version'))
    })

    it('disables both actions with a hint for an observer', async () =>
    {
        const view = Fixtures.View(Fixtures.Populated(), 'read')
        await view.Refresh()
        for (const label of ['Gate version', 'Ungate version'])
        {
            const act = Fixtures.ActByLabel(view, label)
            assert.equal(act.Enabled, false)
            assert.ok((act.DisabledHint ?? '').length > 0)
        }
    })

    it('gates a version, re-fetches and returns to normal', async () =>
    {
        const client = Fixtures.Populated()
        const view = Fixtures.View(client)
        await view.Refresh()
        Fixtures.ActByLabel(view, 'Gate version').Press()
        assert.equal(view.Mode, GatingMode.Gate)
        const boxes = Fixtures.FormBoxes(view)
        boxes[0].Text = 't'
        boxes[1].Text = 'v'
        const before = client.Calls
        Fixtures.ActByLabel(view, 'Gate').Press()
        await new Promise(r => setTimeout(r, 20))
        assert.deepEqual(client.Gated, [['t', 'v']])
        assert.ok(client.Calls > before)
        assert.equal(view.Mode, GatingMode.Normal)
    })

    it('ungates a version, re-fetches and returns to normal', async () =>
    {
        const client = Fixtures.Populated()
        const view = Fixtures.View(client)
        await view.Refresh()
        Fixtures.ActByLabel(view, 'Ungate version').Press()
        assert.equal(view.Mode, GatingMode.Ungate)
        const boxes = Fixtures.FormBoxes(view)
        boxes[0].Text = 't'
        boxes[1].Text = 'v'
        const before = client.Calls
        Fixtures.ActByLabel(view, 'Ungate').Press()
        await new Promise(r => setTimeout(r, 20))
        assert.deepEqual(client.Ungated, [['t', 'v']])
        assert.ok(client.Calls > before)
        assert.equal(view.Mode, GatingMode.Normal)
    })

    it('blank fields make no call, show an error and stay in the mode', async () =>
    {
        const client = Fixtures.Populated()
        const view = Fixtures.View(client)
        await view.Refresh()
        Fixtures.ActByLabel(view, 'Gate version').Press()
        Fixtures.ActByLabel(view, 'Gate').Press()
        await new Promise(r => setTimeout(r, 20))
        assert.equal(client.Gated.length, 0)
        assert.ok(view.ErrorLine.length > 0)
        assert.equal(view.Mode, GatingMode.Gate)
    })

    it('a failed gate shows an error and stays in the mode', async () =>
    {
        const client = Fixtures.Populated()
        client.FailGate = true
        const view = Fixtures.View(client)
        await view.Refresh()
        Fixtures.ActByLabel(view, 'Gate version').Press()
        const boxes = Fixtures.FormBoxes(view)
        boxes[0].Text = 't'
        boxes[1].Text = 'v'
        Fixtures.ActByLabel(view, 'Gate').Press()
        await new Promise(r => setTimeout(r, 20))
        assert.ok(view.ErrorLine.length > 0)
        assert.equal(view.Mode, GatingMode.Gate)
    })

    it('a Refresh with a form open leaves it intact, then fetching resumes in normal mode', async () =>
    {
        const client = Fixtures.Populated()
        const view = Fixtures.View(client)
        await view.Refresh()
        Fixtures.ActByLabel(view, 'Gate version').Press()
        const boxes = Fixtures.FormBoxes(view)
        boxes[0].Text = 'tenant-x'
        boxes[1].Text = '9.9.9'
        const before = client.Calls
        await view.Refresh()
        assert.equal(view.Mode, GatingMode.Gate)
        assert.equal(client.Calls, before)
        const after = Fixtures.FormBoxes(view)
        assert.equal(after.length, 2)
        assert.strictEqual(after[0], boxes[0])
        assert.strictEqual(after[1], boxes[1])
        assert.equal(after[0].Text, 'tenant-x')
        assert.equal(after[1].Text, '9.9.9')
        view.EnterMode(GatingMode.Normal)
        await view.Refresh()
        assert.ok(client.Calls > before)
    })

    it('an empty policy is still actionable for a full operator', async () =>
    {
        const view = Fixtures.View(new FakeClient([], [], [], [], []))
        await view.Refresh()
        assert.notEqual(view.Host.State, ScreenState.Empty)
        assert.ok(Fixtures.ActByLabel(view, 'Gate version'))
        assert.ok(Fixtures.ActByLabel(view, 'Ungate version'))
        view.EnterMode(GatingMode.Gate)
        assert.equal(view.Mode, GatingMode.Gate)
        assert.equal(Fixtures.FormBoxes(view).length, 2)
    })

    it('EnterMode does not fetch', async () =>
    {
        const client = Fixtures.Populated()
        const view = Fixtures.View(client)
        await view.Refresh()
        const before = client.Calls
        view.EnterMode(GatingMode.Gate)
        view.EnterMode(GatingMode.Ungate)
        assert.equal(client.Calls, before)
    })

    it('cancel returns to normal mode', async () =>
    {
        const view = Fixtures.View(Fixtures.Populated())
        await view.Refresh()
        view.EnterMode(GatingMode.Gate)
        Fixtures.Cancel(view)
        assert.equal(view.Mode, GatingMode.Normal)
        assert.equal(Fixtures.FormBoxes(view).length, 0)
    })

    it('a failed ungate shows an error and stays in ungate mode', async () =>
    {
        const client = Fixtures.Populated()
        client.FailGate = true
        const view = Fixtures.View(client)
        await view.Refresh()
        view.EnterMode(GatingMode.Ungate)
        const boxes = Fixtures.FormBoxes(view)
        boxes[0].Text = 't'
        boxes[1].Text = 'v'
        Fixtures.ActByLabel(view, 'Ungate').Press()
        await new Promise(r => setTimeout(r, 20))
        assert.ok(view.ErrorLine.length > 0)
        assert.equal(view.Mode, GatingMode.Ungate)
        assert.equal(client.Ungated.length, 0)
    })

    it('blank ungate fields make no call and show the required error', async () =>
    {
        const client = Fixtures.Populated()
        const view = Fixtures.View(client)
        await view.Refresh()
        view.EnterMode(GatingMode.Ungate)
        Fixtures.FormBoxes(view)[0].Text = 't'
        Fixtures.ActByLabel(view, 'Ungate').Press()
        await new Promise(r => setTimeout(r, 20))
        assert.equal(client.Ungated.length, 0)
        assert.ok(view.ErrorLine.length > 0)
        assert.equal(view.Mode, GatingMode.Ungate)
    })

    it('renders the policy actions', async () =>
    {
        const view = Fixtures.View(Fixtures.Populated())
        await view.Refresh()
        for (const label of ['Set channels', 'Set floor', 'Hold'])
        {
            assert.ok(Fixtures.ActByLabel(view, label))
        }
    })

    it('inert policy actions for an observer', async () =>
    {
        const view = Fixtures.View(Fixtures.Populated(), 'read')
        await view.Refresh()
        for (const label of ['Set channels', 'Set floor', 'Hold'])
        {
            const act = Fixtures.ActByLabel(view, label)
            assert.equal(act.Enabled, false)
            act.Press()
            assert.equal(view.Mode, GatingMode.Normal)
        }
    })

    it('EnterMode renders the matching inline form with no fetch', async () =>
    {
        const client = Fixtures.Populated()
        const view = Fixtures.View(client)
        await view.Refresh()
        const before = client.Calls
        view.EnterMode(GatingMode.SetChannels)
        assert.ok(Fixtures.Box(view, 'Tenant id'))
        assert.ok(Fixtures.Toggle(view, 'stable'))
        assert.ok(Fixtures.Toggle(view, 'early'))
        view.EnterMode(GatingMode.SetMinVersion)
        assert.ok(Fixtures.Box(view, 'Version'))
        assert.ok(Fixtures.ActByLabel(view, 'Clear'))
        view.EnterMode(GatingMode.Hold)
        assert.ok(Fixtures.Box(view, 'Reason'))
        assert.ok(Fixtures.ActByLabel(view, 'Release'))
        assert.equal(client.Calls, before)
    })

    it('applies channels via toggles, re-fetches and returns to normal', async () =>
    {
        const client = Fixtures.Populated()
        const view = Fixtures.View(client)
        await view.Refresh()
        view.EnterMode(GatingMode.SetChannels)
        Fixtures.Box(view, 'Tenant id').Text = 't1'
        Fixtures.Toggle(view, 'stable').Press()
        Fixtures.Toggle(view, 'early').Press()
        Fixtures.Toggle(view, 'early').Press()
        assert.equal((Fixtures.Toggle(view, 'stable').Content as TextBlock).Text, '[x] stable')
        assert.equal((Fixtures.Toggle(view, 'early').Content as TextBlock).Text, '[ ] early')
        const before = client.ListPoliciesCalls
        Fixtures.ActByLabel(view, 'Apply').Press()
        await new Promise(r => setTimeout(r, 20))
        assert.deepEqual(client.PolicyCalls, [['channels', 't1', ['stable']]])
        assert.equal(view.Mode, GatingMode.Normal)
        assert.ok(client.ListPoliciesCalls > before)
    })

    it('channels with none selected make no call', async () =>
    {
        const client = Fixtures.Populated()
        const view = Fixtures.View(client)
        await view.Refresh()
        view.EnterMode(GatingMode.SetChannels)
        Fixtures.Box(view, 'Tenant id').Text = 't1'
        Fixtures.ActByLabel(view, 'Apply').Press()
        await new Promise(r => setTimeout(r, 20))
        assert.equal(client.PolicyCalls.length, 0)
        assert.ok(view.ErrorLine.length > 0)
        assert.equal(view.Mode, GatingMode.SetChannels)
    })

    it('sets and clears the minimum version', async () =>
    {
        const client = Fixtures.Populated()
        const view = Fixtures.View(client)
        await view.Refresh()
        view.EnterMode(GatingMode.SetMinVersion)
        Fixtures.Box(view, 'Tenant id').Text = 't1'
        Fixtures.Box(view, 'Version').Text = '1.2.0'
        Fixtures.ActByLabel(view, 'Apply').Press()
        await new Promise(r => setTimeout(r, 20))
        assert.equal(view.Mode, GatingMode.Normal)
        view.EnterMode(GatingMode.SetMinVersion)
        Fixtures.Box(view, 'Tenant id').Text = 't1'
        Fixtures.ActByLabel(view, 'Clear').Press()
        await new Promise(r => setTimeout(r, 20))
        assert.deepEqual(client.PolicyCalls, [['minVersion', 't1', '1.2.0'], ['clearMinVersion', 't1']])
        assert.equal(view.Mode, GatingMode.Normal)
    })

    it('holds with a reason and releases', async () =>
    {
        const client = Fixtures.Populated()
        const view = Fixtures.View(client)
        await view.Refresh()
        view.EnterMode(GatingMode.Hold)
        Fixtures.Box(view, 'Tenant id').Text = 't1'
        Fixtures.LastActByLabel(view, 'Hold').Press()
        await new Promise(r => setTimeout(r, 20))
        assert.equal(client.PolicyCalls.length, 0)
        assert.equal(view.Mode, GatingMode.Hold)
        Fixtures.Box(view, 'Reason').Text = 'audit'
        Fixtures.LastActByLabel(view, 'Hold').Press()
        await new Promise(r => setTimeout(r, 20))
        assert.equal(view.Mode, GatingMode.Normal)
        view.EnterMode(GatingMode.Hold)
        Fixtures.Box(view, 'Tenant id').Text = 't1'
        Fixtures.ActByLabel(view, 'Release').Press()
        await new Promise(r => setTimeout(r, 20))
        assert.deepEqual(client.PolicyCalls, [['hold', 't1', 'audit'], ['clearHold', 't1']])
        assert.equal(view.Mode, GatingMode.Normal)
    })

    it('renders a Held indicator with the reason in the policy section', async () =>
    {
        const client = Fixtures.Populated()
        client.Policies = [{ tenantId: 't1', hold: { reason: 'audit freeze', actor: 'a', at: '2026-01-02T03:04:05Z' } }]
        const view = Fixtures.View(client)
        await view.Refresh()
        const texts = Fixtures.Texts(view)
        assert.ok(texts.includes('Tenant policy'))
        assert.ok(texts.some(t => t.startsWith('Held') && t.includes('audit freeze')))
    })

    it('shows a blocked tag on a gated row', async () =>
    {
        const client = Fixtures.Populated()
        client.Manifests = [{ id: '1.0', image: 'img', publishedAt: '2026-01-01T00:00:00Z', withdrawn: true }]
        const view = Fixtures.View(client)
        await view.Refresh()
        assert.ok(Fixtures.Texts(view.GatedTable).some(t => t.startsWith('Blocked: ') && t.includes('withdrawn')))
    })
})
