import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Application, Key } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { HiveDetailView } from '../src/hive-detail-view.js'
import { HiveDetailViewModel } from '../src/hive-detail-view-model.js'
import { Banner, KeyActivatedButton, ObservedPanel, ScreenState } from '../src/kit/index.js'
import type { FleetHiveDto } from '../src/portal-types.js'

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
        for (const expected of ['Release policy', 'Channels', 'Minimum version', 'Hold', hp.channelsLabel, '1.2.0', hp.heldLabel])
        {
            assert.ok(texts.includes(expected), expected)
        }
    })

    it('shows default release-policy labels when the hive has no policy', () =>
    {
        const vm = Fixtures.Connected()
        const hp = vm.HivePolicy
        const texts = Fixtures.Texts(new HiveDetailView(vm, () => undefined))
        for (const expected of ['Release policy', hp.channelsLabel, hp.minVersionLabel, hp.heldLabel])
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
})
