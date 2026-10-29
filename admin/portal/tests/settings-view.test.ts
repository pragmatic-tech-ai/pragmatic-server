import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import type { ControlPlaneClient } from '../src/api-client.js'
import { OperatorContext } from '../src/operator-context.js'
import { SettingsView } from '../src/settings-view.js'
import { DataTable, DeniedStatePanel, ErrorStatePanel, KeyValueGrid, ScreenState } from '../src/kit/index.js'
import type { OperatorSummaryDto } from '../src/portal-types.js'

class FakeClient
{
    public Calls = 0
    public Fail = false

    public constructor(private readonly roster: OperatorSummaryDto[])
    {
    }

    public ListOperators(): Promise<OperatorSummaryDto[]>
    {
        this.Calls++
        if (this.Fail)
        {
            return Promise.reject(new Error('boom'))
        }
        return Promise.resolve(this.roster)
    }
}

class Fixtures
{
    public static Email = 'me@example.com'

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

    public static Client(): FakeClient
    {
        return new FakeClient([
            { email: 'zed@example.com', role: 'readonly' },
            { email: 'amy@example.com', role: 'full' },
        ])
    }

    public static View(client: FakeClient, wireRole: string): SettingsView
    {
        return new SettingsView(client as unknown as ControlPlaneClient, OperatorContext.FromWire(wireRole), Fixtures.Email)
    }

    public static Texts(view: SettingsView): string[]
    {
        return Fixtures.Walk(view).filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
    }
}

describe('SettingsView', () =>
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

    it('shows the session and a roster table for a full operator', async () =>
    {
        const client = Fixtures.Client()
        const view = Fixtures.View(client, 'full')
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.ok(Fixtures.Walk(view).some(n => n instanceof KeyValueGrid))
        const texts = Fixtures.Texts(view)
        assert.ok(texts.includes(Fixtures.Email))
        assert.ok(texts.includes('Operator'))
        assert.equal(view.Table?.Rows.length, 2)
        assert.equal(client.Calls, 1)
    })

    it('shows the session and a denied note for an observer, without fetching', async () =>
    {
        const client = Fixtures.Client()
        const view = Fixtures.View(client, 'readonly')
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.ok(Fixtures.Texts(view).includes('Observer'))
        assert.ok(Fixtures.Walk(view).some(n => n instanceof DeniedStatePanel))
        assert.equal(Fixtures.Walk(view).some(n => n instanceof DataTable), false)
        assert.equal(view.Table, undefined)
        assert.equal(client.Calls, 0)
    })

    it('shows the error state and onRetry recovers', async () =>
    {
        const client = Fixtures.Client()
        client.Fail = true
        const view = Fixtures.View(client, 'full')
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Error)
        client.Fail = false
        const panel = Fixtures.Walk(view).find(n => n instanceof ErrorStatePanel) as ErrorStatePanel
        assert.ok(panel)
        for (const h of (panel.RetryButton as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
        await new Promise(r => setTimeout(r, 0))
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.Table?.Rows.length, 2)
    })

    it('survives a second Refresh', async () =>
    {
        const view = Fixtures.View(Fixtures.Client(), 'full')
        await view.Refresh()
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.Table?.Rows.length, 2)
    })

    it('survives a second Refresh as an observer', async () =>
    {
        const view = Fixtures.View(Fixtures.Client(), 'readonly')
        await view.Refresh()
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
    })
})
