import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { TextDecorations } from '@pragmatic-tech-ai/mural/visual-engine'
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

    // Finds the first text node whose Text includes `needle` and returns its TextDecorations.
    public static DecorationsOf(node: unknown, needle: string): TextDecorations | undefined
    {
        const n = node as { Text?: unknown; TextDecorations?: TextDecorations; Children?: Iterable<unknown> }
        if (typeof n.Text === 'string' && n.Text.includes(needle))
        {
            return n.TextDecorations
        }
        if (n.Children !== undefined)
        {
            for (const c of n.Children)
            {
                const found = Fixtures.DecorationsOf(c, needle)
                if (found !== undefined)
                {
                    return found
                }
            }
        }
        return undefined
    }
}

class FakeSource implements IHiveDetailSource
{
    public Target = 'v2'
    public Fail: Error | undefined
    private manifests: ManifestDto[] = [
        { id: 'v1', image: 'img:v1', publishedAt: '2026-01-01' },
        { id: 'v2', image: 'img:v2', publishedAt: '2026-02-01' },
        { id: 'v3', image: 'img:v3', publishedAt: '2026-03-01' },
    ]

    public SetManifests(manifests: ManifestDto[]): void
    {
        this.manifests = manifests
    }

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

    it('renders a withdrawn version struck through with no roll button', async () =>
    {
        const src = new FakeSource()
        src.Target = 'v3'
        src.SetManifests([
            { id: 'v1', image: 'img:v1', publishedAt: '2026-01-01', withdrawn: true },
            { id: 'v2', image: 'img:v2', publishedAt: '2026-02-01' },
            { id: 'v3', image: 'img:v3', publishedAt: '2026-03-01' },
        ])
        const view = new HiveDetailView(src, Hive)
        await view.Refresh()
        const texts = Fixtures.Texts(view)
        // v3 Current (no button), v2 Previous (RollBack), v1 Withdrawn (struck through, no button).
        assert.ok(texts.includes('v1  ' + HiveDetailView.BadgeLabels[3]))
        assert.equal(Fixtures.DecorationsOf(view, 'v1  ' + HiveDetailView.BadgeLabels[3]), TextDecorations.Strikethrough)
        assert.ok(texts.includes(HiveDetailView.RollBackLabel))
        assert.ok(!texts.includes(HiveDetailView.SetTargetLabel))
    })

    it('does not strike through a withdrawn version that is still the current/running one', async () =>
    {
        const src = new FakeSource()
        src.Target = 'v3'
        src.SetManifests([
            { id: 'v1', image: 'img:v1', publishedAt: '2026-01-01' },
            { id: 'v2', image: 'img:v2', publishedAt: '2026-02-01' },
            { id: 'v3', image: 'img:v3', publishedAt: '2026-03-01', withdrawn: true },
        ])
        const view = new HiveDetailView(src, Hive)
        await view.Refresh()
        // v3 is withdrawn but running: keeps the Current badge and is NOT struck through.
        const currentLabel = 'v3  ' + HiveDetailView.BadgeLabels[0]
        assert.ok(Fixtures.Texts(view).includes(currentLabel))
        assert.notEqual(Fixtures.DecorationsOf(view, currentLabel), TextDecorations.Strikethrough)
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
