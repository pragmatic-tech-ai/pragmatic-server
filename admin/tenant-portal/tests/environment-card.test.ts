import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { EnvironmentCard } from '../src/environment-card.js'
import { EnvironmentRow } from '../src/environment-row.js'
import { StatusPill } from '../src/kit/status-pill.js'
import { PillKind } from '../src/kit/pill-kinds.js'
import { EnvStatus, EnvType, Template } from '../src/tenant-types.js'
import type { EnvironmentDto, HiveHealthDto } from '../src/tenant-types.js'

class Fixtures
{
    public static Row(name: string, status: EnvStatus, health?: HiveHealthDto): EnvironmentRow
    {
        const dto: EnvironmentDto = { name, template: Template.DemoContoso, type: EnvType.Runtime, environmentId: 'id-' + name, hostPort: 1, status, createdAt: '', httpUrl: 'http://' + name + '.example', wsUrl: '' }
        return new EnvironmentRow(dto, health)
    }

    public static Health(name: string): HiveHealthDto
    {
        return { environmentName: name, ready: true, runningImage: 'reg/app:1.2.3', detail: '' }
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
        const content = (node as { Content?: unknown }).Content
        if (content !== undefined && content !== null && typeof content === 'object')
        {
            Fixtures.Collect(content, out)
        }
        return out
    }

    public static Texts(node: unknown): string[]
    {
        return Fixtures.Collect(node).filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
    }

    public static Pills(node: unknown): PillKind[]
    {
        return Fixtures.Collect(node).filter(n => n instanceof StatusPill).map(n => (n as StatusPill).Kind)
    }
}

describe('EnvironmentCard', () =>
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

    it('Running card shows name, two pills, template+version and URL', () =>
    {
        const row = Fixtures.Row('prod', EnvStatus.Running, Fixtures.Health('prod'))
        const card = new EnvironmentCard({ row, onOpen: () => { } })
        const texts = Fixtures.Texts(card).join('|')
        assert.ok(texts.includes('prod'))
        assert.ok(texts.includes(Template.DemoContoso))
        assert.ok(texts.includes('1.2.3'))
        assert.ok(texts.includes('http://prod.example'))
        assert.ok(!texts.includes('Not serving'))
        assert.deepEqual(Fixtures.Pills(card), [PillKind.Running, PillKind.Healthy])
    })

    it('Stopped card shows pills and the Not serving label, no URL', () =>
    {
        const row = Fixtures.Row('dev', EnvStatus.Stopped)
        const card = new EnvironmentCard({ row, onOpen: () => { } })
        const texts = Fixtures.Texts(card)
        assert.ok(texts.includes('Not serving'))
        assert.ok(!texts.join('|').includes('http://'))
        assert.deepEqual(Fixtures.Pills(card), [PillKind.Stopped, PillKind.Unknown])
    })

    it('clicking the name invokes onOpen exactly once', () =>
    {
        let opened = 0
        const card = new EnvironmentCard({ row: Fixtures.Row('prod', EnvStatus.Running), onOpen: () => { opened++ } })
        const b = Fixtures.Collect(card).find(x => x instanceof Button && (x.Content as unknown as { Text?: string })?.Text === 'prod')
        assert.ok(b)
        for (const h of (b as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
        assert.equal(opened, 1)
    })
})
