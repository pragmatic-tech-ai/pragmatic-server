import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { HiveDetailView } from '../src/hive-detail-view.js'
import type { IHiveDetailSource } from '../src/hive-detail-view-model.js'
import type { HiveDto, HiveHealthDto, HiveRolloutDto, ManifestDto } from '../src/tenant-types.js'

class Fixtures
{
    public static Texts(node: unknown): string[]
    {
        const n = node as { Text?: unknown; Children?: Iterable<unknown>; Content?: unknown }
        const out: string[] = []
        if (typeof n.Text === 'string')
        {
            out.push(n.Text)
        }
        if (n.Content !== undefined && n.Content !== null)
        {
            out.push(...Fixtures.Texts(n.Content))
        }
        if (n.Children !== undefined)
        {
            for (const c of n.Children)
            {
                out.push(...Fixtures.Texts(c))
            }
        }
        return out
    }

    public static Buttons(node: unknown, out: Button[] = []): Button[]
    {
        if (node instanceof Button)
        {
            out.push(node)
        }
        const n = node as { Children?: Iterable<unknown> }
        if (n.Children !== undefined)
        {
            for (const c of n.Children)
            {
                Fixtures.Buttons(c, out)
            }
        }
        return out
    }

    // Clicks the first button whose label equals `label`.
    public static Click(root: unknown, label: string): void
    {
        const b = Fixtures.Buttons(root).find(x => Fixtures.Texts(x).includes(label))
        assert.ok(b, 'button ' + label)
        for (const h of (b as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
    }

    public static async Settle(): Promise<void>
    {
        await new Promise(r => setTimeout(r, 0))
    }
}

class FakeSource implements IHiveDetailSource
{
    public Target = 'v2'
    public Fail: Error | undefined
    private readonly manifests: ManifestDto[] = [
        { id: 'v1', image: 'img:v1', publishedAt: '2026-01-01' },
        { id: 'v2', image: 'img:v2', publishedAt: '2026-02-01' },
        { id: 'v3', image: 'img:v3', publishedAt: '2026-03-01' },
    ]

    public async ListManifests(): Promise<ManifestDto[]>
    {
        return this.manifests
    }

    public async GetRollout(): Promise<HiveRolloutDto>
    {
        return { targetVersion: this.Target, environments: [{ environmentName: 'e1', runningImage: 'img:' + this.Target, obsolete: false, ready: true }] }
    }

    public async GetHealth(): Promise<HiveHealthDto[]>
    {
        return []
    }

    public async SelectTarget(_hive: string, version: string): Promise<void>
    {
        if (this.Fail !== undefined)
        {
            throw this.Fail
        }
        this.Target = version
    }
}

const Hive: HiveDto = { id: 'h1', tenantId: 't', displayName: 'Hive One', cluster: { backend: 'docker', mode: 'single' }, registry: { mode: 'local' }, createdAt: '' }

describe('HiveDetailView', () =>
{
    it('renders version rows, badge labels and the running version after Refresh', async () =>
    {
        const view = new HiveDetailView(new FakeSource(), Hive)
        await view.Refresh()
        const texts = Fixtures.Texts(view)
        assert.ok(texts.includes('Hive One'))
        assert.ok(texts.includes(HiveDetailView.RunningPrefix + 'v2'))
        assert.ok(texts.includes('v2  ' + HiveDetailView.BadgeLabels[0]))
        assert.ok(texts.includes('v1  ' + HiveDetailView.BadgeLabels[1]))
        assert.ok(texts.includes('v3  ' + HiveDetailView.BadgeLabels[2]))
        assert.ok(texts.includes(HiveDetailView.RollBackLabel))
        assert.ok(texts.includes(HiveDetailView.SetTargetLabel))
    })

    it('shows the failure message and stayed-on version after a failed roll', async () =>
    {
        const src = new FakeSource()
        src.Fail = new Error('not gated')
        const view = new HiveDetailView(src, Hive)
        await view.Refresh()
        Fixtures.Click(view, HiveDetailView.SetTargetLabel)
        Fixtures.Click(view, HiveDetailView.ConfirmLabel)
        await Fixtures.Settle()
        const joined = Fixtures.Texts(view).join('|')
        assert.ok(joined.includes('not gated'))
        assert.ok(joined.includes(HiveDetailView.StayedOnPrefix + 'v2'))
        assert.ok(joined.includes(HiveDetailView.RunningPrefix + 'v2'))
    })

    it('re-renders to the new current version after a successful roll', async () =>
    {
        const view = new HiveDetailView(new FakeSource(), Hive)
        await view.Refresh()
        Fixtures.Click(view, HiveDetailView.RollBackLabel)
        assert.ok(Fixtures.Texts(view).includes(HiveDetailView.ConfirmLabel))
        Fixtures.Click(view, HiveDetailView.ConfirmLabel)
        await Fixtures.Settle()
        const texts = Fixtures.Texts(view)
        assert.ok(texts.includes(HiveDetailView.RunningPrefix + 'v1'))
        assert.ok(texts.includes('v1  ' + HiveDetailView.BadgeLabels[0]))
        assert.ok(!texts.includes(HiveDetailView.ConfirmLabel))
    })
})
