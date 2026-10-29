import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { Application, Key } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import type { ControlPlaneClient } from '../src/api-client.js'
import { OperatorContext } from '../src/operator-context.js'
import { HiveDetailView, HivePolicyMode } from '../src/hive-detail-view.js'
import { HiveDetailViewModel } from '../src/hive-detail-view-model.js'
import { Act, Banner, KeyActivatedButton, ObservedPanel, ScreenState } from '../src/kit/index.js'
import type { FleetHiveDto } from '../src/portal-types.js'

class FakeClient
{
    public Calls: unknown[][] = []
    public Fail = false

    public SetHiveChannels(h: string, c: string[]): Promise<void>
    {
        return this.Record(['channels', h, c])
    }

    public SetHiveMinVersion(h: string, v: string): Promise<void>
    {
        return this.Record(['minVersion', h, v])
    }

    public ClearHiveMinVersion(h: string): Promise<void>
    {
        return this.Record(['clearMinVersion', h])
    }

    public SetHiveHold(h: string, r: string): Promise<void>
    {
        return this.Record(['hold', h, r])
    }

    public ClearHiveHold(h: string): Promise<void>
    {
        return this.Record(['clearHold', h])
    }

    private Record(call: unknown[]): Promise<void>
    {
        if (this.Fail)
        {
            return Promise.reject(new Error('no'))
        }
        this.Calls.push(call)
        return Promise.resolve()
    }
}

class Edit
{
    public Client = new FakeClient()
    public Reloads = 0
    public View: HiveDetailView

    public constructor(wire: string = 'full')
    {
        this.View = new HiveDetailView(Fixtures.Connected(), () => undefined, this.Client as unknown as ControlPlaneClient,
            OperatorContext.FromWire(wire), () => { this.Reloads++; return Promise.resolve() })
    }

    public Act(label: string): Act
    {
        const acts = Fixtures.Collect(this.View).filter(n => n instanceof Act && (n.Content as TextBlock).Text === label)
        return acts[acts.length - 1] as Act
    }

    public Box(placeholder: string): TextBox
    {
        return Fixtures.Collect(this.View).find(n => n instanceof TextBox && n.Placeholder === placeholder) as TextBox
    }

    public Plain(text: string): KeyActivatedButton
    {
        return Fixtures.Collect(this.View).find(n => n instanceof KeyActivatedButton && !(n instanceof Act)
            && (n.Content as TextBlock | undefined)?.Text?.endsWith(text)) as KeyActivatedButton
    }

    public static Settle(): Promise<void>
    {
        return new Promise(r => setTimeout(r, 20))
    }
}

class Fixtures
{
    public static Hive(lastSeen: string | null, envs: unknown[]): FleetHiveDto
    {
        return {
            id: 'h1',
            displayName: 'Hive one',
            tenant: { id: 't1', displayName: 'Tenant t1' },
            client: { id: 'c1', displayName: 'Acme' },
            clusterBackend: 'k8s',
            clusterMode: 'single',
            lastSeen,
            environments: envs,
        } as unknown as FleetHiveDto
    }

    public static Envs(): unknown[]
    {
        return [
            { name: 'dev', ready: true, image: 'img:1', detail: 'ok' },
            { name: 'prod', ready: false, detail: 'crash' },
        ]
    }

    public static Connected(): HiveDetailViewModel
    {
        return new HiveDetailViewModel(Fixtures.Hive(new Date().toISOString(), Fixtures.Envs()))
    }

    public static Quiet(): HiveDetailViewModel
    {
        const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
        return new HiveDetailViewModel(Fixtures.Hive(old, Fixtures.Envs()))
    }

    public static Awaiting(): HiveDetailViewModel
    {
        return new HiveDetailViewModel(Fixtures.Hive(null, []))
    }

    public static Texts(view: unknown): string[]
    {
        return Fixtures.Collect(view).filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
    }

    public static Collect(node: unknown, out: unknown[] = []): unknown[]
    {
        out.push(node)
        const children = (node as { Children?: Iterable<unknown> }).Children
        if (children !== undefined)
        {
            for (const c of children)
            {
                Fixtures.Collect(c, out)
            }
        }
        return out
    }
}

describe('HiveDetailView', () =>
{
    const ObservedTitle = 'Observed environments'

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

    it('connected hive is populated, has observed panel and no banner', () =>
    {
        const view = new HiveDetailView(Fixtures.Connected(), () => undefined)
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.EnvTable?.Rows.length, 2)
        const nodes = Fixtures.Collect(view)
        assert.ok(nodes.some(n => n instanceof ObservedPanel && n.Title === ObservedTitle))
        assert.ok(!nodes.some(n => n instanceof Banner))
    })

    it('quiet hive shows a banner', () =>
    {
        const view = new HiveDetailView(Fixtures.Quiet(), () => undefined)
        assert.ok(Fixtures.Collect(view).some(n => n instanceof Banner))
    })

    it('awaiting hive shows an empty table', () =>
    {
        const view = new HiveDetailView(Fixtures.Awaiting(), () => undefined)
        assert.equal(view.EnvTable?.Rows.length, 0)
    })

    it('the back button invokes onBack', () =>
    {
        let calls = 0
        const view = new HiveDetailView(Fixtures.Connected(), () => { calls++ })
        const button = Fixtures.Collect(view).find(n => n instanceof KeyActivatedButton) as KeyActivatedButton
        assert.ok(button)
        ;(button as unknown as { OnKeyDown(a: unknown): void }).OnKeyDown({ Key: Key.Return, Handled: false })
        assert.equal(calls, 1)
    })

    it('renders the observed-history rows', () =>
    {
        const obs = [
            { id: 'o2', hiveId: 'h1', reportedAt: new Date().toISOString(), environments: [{ environmentName: 'a', ready: true, detail: '' }] },
            { id: 'o1', hiveId: 'h1', reportedAt: new Date().toISOString(), environments: [] },
        ]
        const vm = new HiveDetailViewModel(Fixtures.Hive(null, []), undefined, undefined, obs)
        assert.equal(new HiveDetailView(vm, () => undefined).HistoryTable?.Rows.length, 2)
    })

    it('renders the version-history rows', () =>
    {
        const ledger = [
            { id: 'l2', version: '1.1.0', action: 'adopted', at: new Date().toISOString() },
            { id: 'l1', version: '1.0.0', action: 'gated', at: new Date().toISOString() },
        ]
        const vm = new HiveDetailViewModel(Fixtures.Hive(null, []), undefined, undefined, [], ledger)
        assert.equal(new HiveDetailView(vm, () => undefined).LedgerTable?.Rows.length, 2)
    })

    it('renders the release-policy section with the hive policy labels', () =>
    {
        const policy = { tenantId: 't1', hiveId: 'h1', channels: ['stable' as const], minVersion: '1.2.0', hold: { reason: 'r', actor: 'a', at: new Date().toISOString() } }
        const vm = new HiveDetailViewModel(Fixtures.Hive(null, []), undefined, undefined, [], [], policy)
        const hp = vm.HivePolicy
        const texts = Fixtures.Texts(new HiveDetailView(vm, () => undefined))
        for (const expected of ['Per-hive policy', 'Channels', 'Minimum version', 'Hold', hp.channelsLabel, '1.2.0', hp.heldLabel])
        {
            assert.ok(texts.includes(expected), expected)
        }
    })

    it('shows default release-policy labels when the hive has no policy', () =>
    {
        const vm = Fixtures.Connected()
        const hp = vm.HivePolicy
        const texts = Fixtures.Texts(new HiveDetailView(vm, () => undefined))
        for (const expected of ['Per-hive policy', hp.channelsLabel, hp.minVersionLabel, hp.heldLabel])
        {
            assert.ok(texts.includes(expected), expected)
        }
    })

    it('shows an empty version-history table when there is no ledger', () =>
    {
        const view = new HiveDetailView(Fixtures.Connected(), () => undefined)
        assert.equal(view.LedgerTable?.Rows.length, 0)
    })

    it('shows an empty history table when there are no observations', () =>
    {
        const view = new HiveDetailView(Fixtures.Connected(), () => undefined)
        assert.equal(view.HistoryTable?.Rows.length, 0)
    })

    it('without a client the detail stays render-only', () =>
    {
        const view = new HiveDetailView(Fixtures.Connected(), () => undefined)
        assert.equal(view.Mode, HivePolicyMode.Normal)
        assert.ok(!Fixtures.Collect(view).some(n => n instanceof Act))
    })

    it('set min version applies via SetHiveMinVersion and reloads once', async () =>
    {
        const e = new Edit()
        e.View.EnterMode(HivePolicyMode.SetMinVersion)
        e.Box('Version').Text = ' 1.2.0 '
        e.Act('Apply').Press()
        await Edit.Settle()
        assert.deepEqual(e.Client.Calls, [['minVersion', 'h1', '1.2.0']])
        assert.equal(e.Reloads, 1)
        assert.equal(e.View.Mode, HivePolicyMode.Normal)
    })

    it('clear min version calls ClearHiveMinVersion and reloads', async () =>
    {
        const e = new Edit()
        e.View.EnterMode(HivePolicyMode.SetMinVersion)
        e.Act('Clear').Press()
        await Edit.Settle()
        assert.deepEqual(e.Client.Calls, [['clearMinVersion', 'h1']])
        assert.equal(e.Reloads, 1)
    })

    it('hold with a reason and release', async () =>
    {
        const e = new Edit()
        e.View.EnterMode(HivePolicyMode.Hold)
        e.Box('Reason').Text = 'audit'
        e.Act('Hold').Press()
        await Edit.Settle()
        e.View.EnterMode(HivePolicyMode.Hold)
        e.Act('Release').Press()
        await Edit.Settle()
        assert.deepEqual(e.Client.Calls, [['hold', 'h1', 'audit'], ['clearHold', 'h1']])
        assert.equal(e.Reloads, 2)
    })

    it('toggling stable and early applies both channels', async () =>
    {
        const e = new Edit()
        e.View.EnterMode(HivePolicyMode.SetChannels)
        e.Plain('stable').Press()
        e.Plain('early').Press()
        e.Act('Apply').Press()
        await Edit.Settle()
        assert.deepEqual(e.Client.Calls, [['channels', 'h1', ['stable', 'early']]])
        assert.equal(e.Reloads, 1)
    })

    it('an empty version shows the required line and makes no call', async () =>
    {
        const e = new Edit()
        e.View.EnterMode(HivePolicyMode.SetMinVersion)
        e.Act('Apply').Press()
        await Edit.Settle()
        assert.equal(e.View.ErrorLine, 'Version is required.')
        assert.equal(e.Client.Calls.length, 0)
        assert.equal(e.Reloads, 0)
    })

    it('a client rejection keeps the form open and does not reload', async () =>
    {
        const e = new Edit()
        e.Client.Fail = true
        e.View.EnterMode(HivePolicyMode.SetMinVersion)
        e.Box('Version').Text = '1.0.0'
        e.Act('Apply').Press()
        await Edit.Settle()
        assert.equal(e.View.Mode, HivePolicyMode.SetMinVersion)
        assert.ok(e.View.ErrorLine.includes('could not be saved'))
        assert.equal(e.Reloads, 0)
    })

    it('cancel returns to normal without calling the client', () =>
    {
        const e = new Edit()
        e.View.EnterMode(HivePolicyMode.Hold)
        e.Plain('Cancel').Press()
        assert.equal(e.View.Mode, HivePolicyMode.Normal)
        assert.equal(e.Client.Calls.length, 0)
    })

    it('a hive with no policy yet can set a floor', async () =>
    {
        const e = new Edit()
        e.Act('Set floor').Press()
        assert.equal(e.View.Mode, HivePolicyMode.SetMinVersion)
        e.Box('Version').Text = '2.0.0'
        e.Act('Apply').Press()
        await Edit.Settle()
        assert.deepEqual(e.Client.Calls, [['minVersion', 'h1', '2.0.0']])
    })

    it('a read-only operator gets gated actions and nothing reaches the client', () =>
    {
        const e = new Edit('readonly')
        for (const label of ['Set channels', 'Set floor', 'Hold'])
        {
            const act = e.Act(label)
            assert.equal(act.Enabled, false)
            act.Press()
        }
        assert.equal(e.View.Mode, HivePolicyMode.Normal)
        assert.equal(e.Client.Calls.length, 0)
    })

    it('a read-only operator has every submit action gated in each form', async () =>
    {
        const e = new Edit('readonly')
        const submits = [
            [HivePolicyMode.SetChannels, ['Apply']],
            [HivePolicyMode.SetMinVersion, ['Apply', 'Clear']],
            [HivePolicyMode.Hold, ['Hold', 'Release']],
        ] as const
        for (const [mode, labels] of submits)
        {
            e.View.EnterMode(mode)
            for (const label of labels)
            {
                const act = e.Act(label)
                assert.ok(act, label)
                assert.equal(act.Enabled, false, label)
                act.Press()
            }
        }
        await Edit.Settle()
        assert.equal(e.Client.Calls.length, 0)
        assert.equal(e.Reloads, 0)
    })
})
