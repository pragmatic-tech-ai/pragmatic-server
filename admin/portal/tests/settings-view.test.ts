import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import type { ControlPlaneClient } from '../src/api-client.js'
import { OperatorContext } from '../src/operator-context.js'
import { SettingsMode, SettingsView } from '../src/settings-view.js'
import { Act, DataTable, DeniedStatePanel, KeyActivatedButton, ErrorStatePanel, KeyValueGrid, ScreenState } from '../src/kit/index.js'
import type { OperatorSummaryDto } from '../src/portal-types.js'

class FakeClient
{
    public Calls = 0
    public Fail = false
    public Created: Array<[string, string, string]> = []
    public CreateError: Error | undefined

    public constructor(private readonly roster: OperatorSummaryDto[])
    {
    }

    public CreateOperator(email: string, password: string, role: string): Promise<void>
    {
        if (this.CreateError !== undefined)
        {
            return Promise.reject(this.CreateError)
        }
        this.Created.push([email, password, role])
        return Promise.resolve()
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

    public static Click(node: unknown): void
    {
        for (const h of (node as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
    }

    public static ActByLabel(view: unknown, label: string): Act
    {
        return Fixtures.Walk(view).find(n => n instanceof Act && (n.Content as TextBlock).Text === label) as Act
    }

    public static Boxes(view: unknown): TextBox[]
    {
        return Fixtures.Walk(view).filter(n => n instanceof TextBox && ['Email', 'Password'].includes(n.Placeholder)) as TextBox[]
    }

    public static async Tick(): Promise<void>
    {
        await new Promise(r => setTimeout(r, 0))
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
        const grid = Fixtures.Walk(view).find(n => n instanceof KeyValueGrid)
        const sessionTexts = Fixtures.Walk(grid).filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
        assert.ok(sessionTexts.includes(Fixtures.Email))
        assert.ok(sessionTexts.includes('Operator'))
        assert.equal(view.Table?.Rows.length, 2)
        assert.equal(client.Calls, 1)
    })

    it('renders the roster table rows in sorted email order', async () =>
    {
        const client = new FakeClient([
            { email: 'zoe@x', role: 'full' },
            { email: 'amy@x', role: 'readonly' },
        ])
        const view = Fixtures.View(client, 'full')
        await view.Refresh()
        const texts = Fixtures.Walk(view.Table).filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
        const amy = texts.indexOf('amy@x')
        const zoe = texts.indexOf('zoe@x')
        assert.ok(amy >= 0 && zoe >= 0)
        assert.ok(amy < zoe)
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

    it('offers the invite action to a full operator only', async () =>
    {
        const full = Fixtures.View(Fixtures.Client(), 'full')
        await full.Refresh()
        assert.ok(full.InviteAct)
        assert.ok(Fixtures.ActByLabel(full, 'Invite operator'))
        const obs = Fixtures.View(Fixtures.Client(), 'readonly')
        await obs.Refresh()
        assert.equal(obs.InviteAct, undefined)
        assert.equal(Fixtures.ActByLabel(obs, 'Invite operator'), undefined)
    })

    it('shows the invite form with a masked password and a least-privilege role default', async () =>
    {
        const client = Fixtures.Client()
        const view = Fixtures.View(client, 'full')
        await view.Refresh()
        Fixtures.Click(Fixtures.ActByLabel(view, 'Invite operator'))
        assert.equal(view.Mode, SettingsMode.Invite)
        assert.equal(client.Calls, 1)
        const boxes = Fixtures.Boxes(view)
        assert.equal(boxes.length, 2)
        assert.equal(boxes[1].IsPassword, true)
        assert.equal((view.RoleBox?.SelectedItem as { Value: string }).Value, 'readonly')
    })

    it('creates the operator, refetches the roster and returns to normal', async () =>
    {
        const client = Fixtures.Client()
        const view = Fixtures.View(client, 'full')
        await view.Refresh()
        view.EnterMode(SettingsMode.Invite)
        const boxes = Fixtures.Boxes(view)
        boxes[0].Text = 'new@example.com'
        boxes[1].Text = 'pw-123'
        Fixtures.Click(Fixtures.ActByLabel(view, 'Create operator'))
        await Fixtures.Tick()
        assert.deepEqual(client.Created, [['new@example.com', 'pw-123', 'readonly']])
        assert.equal(client.Calls, 2)
        assert.equal(view.Mode, SettingsMode.Normal)
        assert.equal(Fixtures.Boxes(view).length, 0)
    })

    it('does nothing on a blank submit but shows a required-field line', async () =>
    {
        const client = Fixtures.Client()
        const view = Fixtures.View(client, 'full')
        await view.Refresh()
        view.EnterMode(SettingsMode.Invite)
        Fixtures.Click(Fixtures.ActByLabel(view, 'Create operator'))
        await Fixtures.Tick()
        assert.equal(client.Created.length, 0)
        assert.notEqual(view.ErrorLine, '')
        assert.equal(view.Mode, SettingsMode.Invite)
    })

    it('shows the server message and stays in invite mode when create fails', async () =>
    {
        const client = Fixtures.Client()
        client.CreateError = new Error('email already exists')
        const view = Fixtures.View(client, 'full')
        await view.Refresh()
        view.EnterMode(SettingsMode.Invite)
        const boxes = Fixtures.Boxes(view)
        boxes[0].Text = 'a@b.c'
        boxes[1].Text = 'pw'
        Fixtures.Click(Fixtures.ActByLabel(view, 'Create operator'))
        await Fixtures.Tick()
        assert.equal(view.ErrorLine, 'email already exists')
        assert.equal(view.Mode, SettingsMode.Invite)
    })

    it('rebuilds cleanly on Refresh with the form open and cancel returns to normal', async () =>
    {
        const view = Fixtures.View(Fixtures.Client(), 'full')
        await view.Refresh()
        view.EnterMode(SettingsMode.Invite)
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.Mode, SettingsMode.Invite)
        assert.equal(Fixtures.Boxes(view).length, 2)
        const cancel = Fixtures.Walk(view).find(n => n instanceof KeyActivatedButton && !(n instanceof Act)
            && (n.Content as TextBlock | undefined)?.Text === 'Cancel')
        Fixtures.Click(cancel)
        assert.equal(view.Mode, SettingsMode.Normal)
        assert.equal(Fixtures.Boxes(view).length, 0)
    })
})
