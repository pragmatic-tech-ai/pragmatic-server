import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { ApiError } from '../src/api-client.js'
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
    public Ops: string[] = []
    public OpError: Error | undefined

    public SetOperatorRole(email: string, role: string): Promise<void>
    {
        return this.Op(`role:${email}:${role}`)
    }

    public SetOperatorDisabled(email: string, disabled: boolean): Promise<void>
    {
        return this.Op(`disabled:${email}:${disabled}`)
    }

    public RevokeOperatorSessions(email: string): Promise<void>
    {
        return this.Op(`revoke:${email}`)
    }

    public ResetOperatorPassword(email: string): Promise<{ password: string }>
    {
        this.Ops.push(`reset:${email}`)
        return this.OpError !== undefined ? Promise.reject(this.OpError) : Promise.resolve({ password: 'Temp-Secret-42' })
    }

    private Op(s: string): Promise<void>
    {
        this.Ops.push(s)
        return this.OpError !== undefined ? Promise.reject(this.OpError) : Promise.resolve()
    }

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
        (node as KeyActivatedButton).Press()
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
        panel.RetryButton.Press()
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

    it('leaves the open invite form intact across an auto-refresh, then resumes fetching', async () =>
    {
        const client = Fixtures.Client()
        const view = Fixtures.View(client, 'full')
        await view.Refresh()
        view.EnterMode(SettingsMode.Invite)
        const boxes = Fixtures.Boxes(view)
        boxes[0].Text = 'new@example.com'
        boxes[1].Text = 'secret'
        const before = client.Calls
        await view.Refresh()
        assert.equal(view.Mode, SettingsMode.Invite)
        assert.equal(client.Calls, before)
        const after = Fixtures.Boxes(view)
        assert.equal(after.length, 2)
        assert.strictEqual(after[0], boxes[0])
        assert.strictEqual(after[1], boxes[1])
        assert.equal(after[0].Text, 'new@example.com')
        assert.equal(after[1].Text, 'secret')
        const cancel = Fixtures.Walk(view).find(n => n instanceof KeyActivatedButton && !(n instanceof Act)
            && (n.Content as TextBlock | undefined)?.Text === 'Cancel')
        Fixtures.Click(cancel)
        assert.equal(view.Mode, SettingsMode.Normal)
        assert.equal(Fixtures.Boxes(view).length, 0)
        await view.Refresh()
        assert.ok(client.Calls > before)
    })

    it('maps the Full role option to the full wire role on submit', async () =>
    {
        const client = Fixtures.Client()
        const view = Fixtures.View(client, 'full')
        await view.Refresh()
        view.EnterMode(SettingsMode.Invite)
        const boxes = Fixtures.Boxes(view)
        boxes[0].Text = 'boss@example.com'
        boxes[1].Text = 'pw'
        view.RoleBox!.SelectedIndex = 0
        Fixtures.Click(Fixtures.ActByLabel(view, 'Create operator'))
        await Fixtures.Tick()
        assert.deepEqual(client.Created, [['boss@example.com', 'pw', 'full']])
    })

    it('shows the error state in normal mode when a refresh fails to load', async () =>
    {
        const client = Fixtures.Client()
        const view = Fixtures.View(client, 'full')
        await view.Refresh()
        client.Fail = true
        await view.Refresh()
        assert.equal(view.Host.State, ScreenState.Error)
        assert.equal(view.Mode, SettingsMode.Normal)
    })

    it('never opens the invite form for an observer', async () =>
    {
        const view = Fixtures.View(Fixtures.Client(), 'readonly')
        await view.Refresh()
        view.EnterMode(SettingsMode.Invite)
        assert.equal(view.Mode, SettingsMode.Normal)
    })

    it('opens Manage for a roster operator and shows identity and status', async () =>
    {
        const client = new FakeClient([{ email: 'amy@example.com', role: 'full' }, { email: 'dan@example.com', role: 'readonly', disabled: true }])
        const view = Fixtures.View(client, 'full')
        await view.Refresh()
        const texts = Fixtures.Texts(view)
        assert.ok(texts.includes('Disabled') && texts.includes('Active'))
        view.Table!.FocusRow(1)
        view.Table!.ActivateFocused()
        assert.equal(view.Mode, SettingsMode.Manage)
        assert.equal(view.ManagedEmail, 'dan@example.com')
        assert.ok(Fixtures.ActByLabel(view, 'Enable operator'))
        assert.equal(Fixtures.ActByLabel(view, 'Disable operator'), undefined)
    })

    it('never opens Manage for an observer and makes no calls', async () =>
    {
        const client = Fixtures.Client()
        const view = Fixtures.View(client, 'readonly')
        await view.Refresh()
        view.EnterMode(SettingsMode.Manage, 'amy@example.com')
        assert.equal(view.Mode, SettingsMode.Normal)
        assert.equal(view.ChangeRoleAct, undefined)
        assert.equal(client.Calls, 0)
        assert.deepEqual(client.Ops, [])
    })

    it('changes role, returns to normal and re-fetches', async () =>
    {
        const client = Fixtures.Client()
        const view = Fixtures.View(client, 'full')
        await view.Refresh()
        view.EnterMode(SettingsMode.Manage, 'amy@example.com')
        view.ManageRoleBox!.SelectedIndex = 1
        Fixtures.Click(view.ChangeRoleAct)
        await Fixtures.Tick()
        assert.deepEqual(client.Ops, ['role:amy@example.com:readonly'])
        assert.equal(view.Mode, SettingsMode.Normal)
        assert.equal(client.Calls, 2)
    })

    it('reveals a reset password once, keeps it out of rows, and dismisses', async () =>
    {
        const client = Fixtures.Client()
        const view = Fixtures.View(client, 'full')
        await view.Refresh()
        view.EnterMode(SettingsMode.Manage, 'amy@example.com')
        Fixtures.Click(view.ResetPasswordAct)
        await Fixtures.Tick()
        assert.deepEqual(client.Ops, ['reset:amy@example.com'])
        assert.equal(view.Mode, SettingsMode.Reveal)
        assert.equal(view.Reveal?.Value, 'Temp-Secret-42')
        assert.equal(Fixtures.Walk(view.Table).some(n => n instanceof TextBlock && n.Text.includes('Temp-Secret-42')), false)
        const calls = client.Calls
        await view.Refresh()
        assert.equal(view.Mode, SettingsMode.Reveal)
        assert.equal(client.Calls, calls)
        view.Reveal!.ConfirmButton.Press()
        await Fixtures.Tick()
        assert.equal(view.Mode, SettingsMode.Normal)
        assert.equal(view.Reveal, undefined)
        assert.equal(Fixtures.Texts(view).includes('Temp-Secret-42'), false)
        assert.equal(client.Calls, calls + 1)
    })

    it('toggles disabled and revokes sessions', async () =>
    {
        const client = Fixtures.Client()
        const view = Fixtures.View(client, 'full')
        await view.Refresh()
        view.EnterMode(SettingsMode.Manage, 'zed@example.com')
        Fixtures.Click(view.ToggleDisabledAct)
        await Fixtures.Tick()
        view.EnterMode(SettingsMode.Manage, 'zed@example.com')
        Fixtures.Click(view.RevokeSessionsAct)
        await Fixtures.Tick()
        assert.deepEqual(client.Ops, ['disabled:zed@example.com:true', 'revoke:zed@example.com'])
        assert.equal(view.Mode, SettingsMode.Normal)
    })

    it('shows a server 409 reason inline and keeps the panel open', async () =>
    {
        const client = Fixtures.Client()
        client.OpError = new ApiError(409, 'cannot disable the last admin')
        const view = Fixtures.View(client, 'full')
        await view.Refresh()
        view.EnterMode(SettingsMode.Manage, 'amy@example.com')
        Fixtures.Click(view.ToggleDisabledAct)
        await Fixtures.Tick()
        assert.equal(view.ManageErrorLine, 'cannot disable the last admin')
        assert.equal(view.Mode, SettingsMode.Manage)
        Fixtures.Click(view.ResetPasswordAct)
        await Fixtures.Tick()
        assert.equal(view.Mode, SettingsMode.Manage)
        assert.equal(view.ManageErrorLine, 'cannot disable the last admin')
    })
})
