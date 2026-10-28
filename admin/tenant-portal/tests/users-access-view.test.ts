import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Button, ButtonVariant } from '@pragmatic-tech-ai/mural/framework'
import { ConfirmDialog, PillKind, StatusPill } from '../src/kit/index.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import type { AdminSnapshotDto, CreateAccountParams, EnvironmentDto, GrantMutationDto, ITenantNavigator, IUsersAccessSource } from '../src/tenant-types.js'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { UsersAccessView } from '../src/users-access-view.js'

class Fixtures
{
    private static app: Application | undefined

    public static InitApp(): void
    {
        if (Fixtures.app === undefined)
        {
            Fixtures.app = new Application()
            Fixtures.app.initialize({ theme: Pragmatic, scheme: PragmaticLight })
        }
        Application.current = Fixtures.app
    }

    public static Texts(node: unknown): string[]
    {
        const n = node as { Text?: unknown; Children?: Iterable<unknown>; Content?: unknown; ContentChild?: unknown }
        const out: string[] = []
        if (n.ContentChild !== undefined)
        {
            out.push(...Fixtures.Texts(n.ContentChild))
        }
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

    // Like Texts, but skips TextBox nodes (their Text is user input, not rendered output).
    public static TextsSkippingBoxes(node: unknown): string[]
    {
        const n = node as { Text?: unknown; Placeholder?: unknown; Children?: Iterable<unknown>; Content?: unknown }
        if (n.Placeholder !== undefined)
        {
            return []
        }
        const out: string[] = []
        if (typeof n.Text === 'string')
        {
            out.push(n.Text)
        }
        if (n.Content !== undefined && n.Content !== null)
        {
            out.push(...Fixtures.TextsSkippingBoxes(n.Content))
        }
        for (const c of n.Children ?? [])
        {
            out.push(...Fixtures.TextsSkippingBoxes(c))
        }
        return out
    }

    public static Labels(root: unknown): string[]
    {
        return Fixtures.Buttons(root).map(b => Fixtures.Texts(b).join(''))
    }

    public static Click(root: unknown, label: string): void
    {
        const b = Fixtures.Buttons(root).find(x => Fixtures.Texts(x).includes(label))
        assert.ok(b, 'button ' + label)
        for (const h of (b as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
    }

    public static Find<T>(node: unknown, ctor: new (...a: never[]) => T, out: T[] = []): T[]
    {
        if (node instanceof ctor)
        {
            out.push(node)
        }
        const n = node as { Children?: Iterable<unknown>; ContentChild?: unknown }
        if (n.ContentChild !== undefined)
        {
            Fixtures.Find(n.ContentChild, ctor, out)
        }
        for (const c of n.Children ?? [])
        {
            Fixtures.Find(c, ctor, out)
        }
        return out
    }

    public static async Settle(): Promise<void>
    {
        await new Promise(r => setTimeout(r, 0))
    }
}

class FakeSource implements IUsersAccessSource
{
    public envs: EnvironmentDto[] = [{ name: 'dev' } as EnvironmentDto, { name: 'prod' } as EnvironmentDto]
    public listError: Error | undefined
    public snapshotError: Error | undefined
    public snapshot: AdminSnapshotDto = {
        accounts: [
            { principalId: 'me', email: 'me@x.io', disabled: false },
            { principalId: 'bob', email: 'bob@x.io', disabled: true },
        ],
        grants: [
            { subject: 'me', role: 'Owner', resourceKind: 'Environment', resourcePath: ['dev'] },
            { subject: 'bob', role: 'Viewer', resourceKind: 'Environment', resourcePath: ['dev'] },
        ],
    }
    public mutationError: Error | undefined
    public snapshotCalls: string[] = []
    public created: CreateAccountParams[] = []
    public disabled: string[] = []
    public granted: GrantMutationDto[] = []
    public revoked: GrantMutationDto[] = []

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        if (this.listError !== undefined)
        {
            throw this.listError
        }
        return this.envs
    }

    public async GetAdminSnapshot(env: string): Promise<AdminSnapshotDto>
    {
        this.snapshotCalls.push(env)
        if (this.snapshotError !== undefined)
        {
            throw this.snapshotError
        }
        return this.snapshot
    }

    public async CreateAccount(_env: string, params: CreateAccountParams): Promise<void>
    {
        this.Check()
        this.created.push(params)
    }

    public async DisableAccount(_env: string, principalId: string): Promise<void>
    {
        this.Check()
        this.disabled.push(principalId)
    }

    public async GrantRole(_env: string, grant: GrantMutationDto): Promise<void>
    {
        this.Check()
        this.granted.push(grant)
    }

    public async RevokeRole(_env: string, grant: GrantMutationDto): Promise<void>
    {
        this.Check()
        this.revoked.push(grant)
    }

    private Check(): void
    {
        if (this.mutationError !== undefined)
        {
            throw this.mutationError
        }
    }
}

class Nav implements ITenantNavigator
{
    public logins = 0

    public ShowLogin(): void
    {
        this.logins++
    }

    public ShowTree(): void {}
    public ShowHiveDetail(): void {}
    public ShowEnvironmentDetail(): void {}
    public ShowUsersAccess(): void {}
    public ShowServiceTokens(): void {}
    public ShowSection(_section: unknown): void {}
    public get Profile(): undefined { return undefined }
    public get Capabilities(): undefined { return undefined }
    public get OwnerContact(): undefined { return undefined }
}

class Harness
{
    public static async Make(src = new FakeSource()): Promise<{ src: FakeSource; view: UsersAccessView }>
    {
        const view = new UsersAccessView(src, 'me')
        await view.Refresh()
        return { src, view }
    }

    public static BoxOf(view: UsersAccessView, placeholder: string): { Text: string }
    {
        const find = (n: unknown): unknown =>
        {
            const x = n as { Placeholder?: unknown; Children?: Iterable<unknown> }
            if (x.Placeholder === placeholder)
            {
                return x
            }
            for (const c of x.Children ?? [])
            {
                const f = find(c)
                if (f !== undefined)
                {
                    return f
                }
            }
            return undefined
        }
        const box = find(view)
        assert.ok(box, 'box ' + placeholder)
        return box as { Text: string }
    }
}

describe('UsersAccessView', () =>
{
    beforeEach(() => Fixtures.InitApp())

    it('renders one env button per environment and reloads on pick', async () =>
    {
        const { src, view } = await Harness.Make()
        const labels = Fixtures.Labels(view)
        assert.ok(labels.includes('\u25CF dev'))
        assert.ok(labels.includes('prod'))
        Fixtures.Click(view, 'prod')
        await Fixtures.Settle()
        assert.equal(src.snapshotCalls[src.snapshotCalls.length - 1], 'prod')
    })

    it('has a create form; the password lives only in the password TextBox', async () =>
    {
        const { src, view } = await Harness.Make()
        assert.ok(Fixtures.Labels(view).includes('Create'))
        Harness.BoxOf(view, UsersAccessView.EmailPlaceholder).Text = 'n@x.io'
        Harness.BoxOf(view, UsersAccessView.PrincipalPlaceholder).Text = 'n'
        const pw = Harness.BoxOf(view, UsersAccessView.PasswordPlaceholder) as unknown as { Text: string; IsPassword: boolean }
        pw.Text = 'hunter2-secret'
        assert.equal(pw.IsPassword, true)
        assert.ok(!Fixtures.TextsSkippingBoxes(view).includes('hunter2-secret'))
        Fixtures.Click(view, 'Create')
        await Fixtures.Settle()
        await Fixtures.Settle()
        assert.deepEqual(src.created, [{ email: 'n@x.io', principalId: 'n', password: 'hunter2-secret' }])
        assert.equal(pw.Text, '')
        assert.equal(Harness.BoxOf(view, UsersAccessView.EmailPlaceholder).Text, '')
    })

    it('retains create-form text when the create fails', async () =>
    {
        const { src, view } = await Harness.Make()
        src.mutationError = new TenantApiError(409, 'exists')
        Harness.BoxOf(view, UsersAccessView.EmailPlaceholder).Text = 'n@x.io'
        Harness.BoxOf(view, UsersAccessView.PasswordPlaceholder).Text = 'pw'
        Fixtures.Click(view, 'Create')
        await Fixtures.Settle()
        await Fixtures.Settle()
        assert.equal(Harness.BoxOf(view, UsersAccessView.EmailPlaceholder).Text, 'n@x.io')
        assert.equal(Harness.BoxOf(view, UsersAccessView.PasswordPlaceholder).Text, 'pw')
        assert.ok(Fixtures.Texts(view).includes('exists'))
    })

    it('routes a 401 from a load to login', async () =>
    {
        const src = new FakeSource()
        src.snapshotError = new TenantApiError(401, 'expired')
        const nav = new Nav()
        const view = new UsersAccessView(src, 'me')
        view.AttachNavigator(nav)
        await view.Refresh()
        assert.equal(nav.logins, 1)
        assert.ok(!Fixtures.Texts(view).includes('expired'))
    })

    it('routes a 401 from a mutation to login', async () =>
    {
        const src = new FakeSource()
        const nav = new Nav()
        const view = new UsersAccessView(src, 'me')
        view.AttachNavigator(nav)
        await view.Refresh()
        Fixtures.Click(view, 'bob@x.io')
        await Fixtures.Settle()
        src.mutationError = new TenantApiError(401, 'expired')
        Fixtures.Click(view, 'Disable')
        view.ActiveConfirm?.Confirm()
        await Fixtures.Settle()
        await Fixtures.Settle()
        assert.equal(nav.logins, 1)
    })

    it('confirms self-revoke and revokes non-self directly', async () =>
    {
        const { src, view } = await Harness.Make()
        Fixtures.Click(view, 'bob@x.io')
        await Fixtures.Settle()
        Fixtures.Click(view, 'Revoke')
        await Fixtures.Settle()
        await Fixtures.Settle()
        assert.deepEqual(src.revoked.map(r => r.subject), ['bob'])
        Fixtures.Click(view, 'me@x.io')
        await Fixtures.Settle()
        Fixtures.Click(view, 'Revoke')
        await Fixtures.Settle()
        assert.ok(Fixtures.Labels(view).includes('Confirm revoke'))
        Fixtures.Click(view, 'Cancel')
        await Fixtures.Settle()
        assert.ok(!Fixtures.Labels(view).includes('Confirm revoke'))
        assert.equal(src.revoked.length, 1)
        Fixtures.Click(view, 'Revoke')
        await Fixtures.Settle()
        Fixtures.Click(view, 'Confirm revoke')
        await Fixtures.Settle()
        await Fixtures.Settle()
        assert.deepEqual(src.revoked.map(r => r.subject), ['bob', 'me'])
    })

    it('shows the self-revoke confirm on only the targeted grant row', async () =>
    {
        const src = new FakeSource()
        src.snapshot.grants.push({ subject: 'me', role: 'Owner', resourceKind: 'Environment', resourcePath: ['prod'] })
        const { view } = await Harness.Make(src)
        Fixtures.Click(view, 'me@x.io')
        await Fixtures.Settle()
        Fixtures.Click(view, 'Revoke')
        await Fixtures.Settle()
        assert.equal(Fixtures.Labels(view).filter(l => l === 'Confirm revoke').length, 1)
        assert.equal(Fixtures.Labels(view).filter(l => l === 'Revoke').length, 1)
    })

    it('keeps the selected-account section across a reload', async () =>
    {
        const { src, view } = await Harness.Make()
        const before = [...view.AccountRows.Children].length
        Fixtures.Click(view, 'bob@x.io')
        await Fixtures.Settle()
        Fixtures.Click(view, 'Grant')
        await Fixtures.Settle()
        await Fixtures.Settle()
        assert.equal(src.granted.length, 1)
        assert.equal([...view.AccountRows.Children].length, before)
        assert.ok(Fixtures.Texts(view).includes(UsersAccessView.SelectedHeading + 'bob'))
    })

    it('adapts row clicks to the view model', async () =>
    {
        const { view } = await Harness.Make()
        Fixtures.Click(view, 'bob@x.io')
        await Fixtures.Settle()
        assert.ok(Fixtures.Texts(view).includes(UsersAccessView.SelectedHeading + 'bob'))
    })

    it('shows the selected-account section with grants, revoke and disable', async () =>
    {
        const { src, view } = await Harness.Make()
        Fixtures.Click(view, 'bob@x.io')
        await Fixtures.Settle()
        assert.ok(Fixtures.Texts(view).includes('Viewer dev'))
        const labels = Fixtures.Labels(view)
        assert.ok(labels.includes('Revoke'))
        assert.ok(labels.includes('Disable'))
        Fixtures.Click(view, 'Disable')
        await Fixtures.Settle()
        assert.deepEqual(src.disabled, [])
        assert.ok(view.ActiveConfirm)
    })

    it('lists one row per account with email, roles and status', async () =>
    {
        const { view } = await Harness.Make()
        assert.equal([...view.AccountRows.Children].length, 2)
        assert.ok(Fixtures.Texts(view.RowFor('me')).includes('me@x.io'))
        assert.ok(Fixtures.Texts(view.RowFor('bob')).includes('Viewer'))
        assert.equal(view.RowFor('nobody'), undefined)
    })

    it('an account row shows a status pill, role chips and no You tag for others', async () =>
    {
        const src = new FakeSource()
        src.snapshot.grants.push({ subject: 'bob', role: 'Editor', resourceKind: 'Environment', resourcePath: ['dev'] })
        src.snapshot.accounts[1].disabled = false
        const { view } = await Harness.Make(src)
        const row = view.RowFor('bob')
        const pills = Fixtures.Find(row, StatusPill)
        assert.equal(pills.length, 1)
        assert.equal(pills[0].Kind, PillKind.Active)
        const texts = Fixtures.Texts(row)
        assert.ok(texts.includes('Viewer'))
        assert.ok(texts.includes('Editor'))
        assert.ok(!texts.includes('You'))
    })

    it('the signed-in admin own row carries the You tag', async () =>
    {
        const { view } = await Harness.Make()
        assert.ok(Fixtures.Texts(view.RowFor('me')).includes('You'))
    })

    it('a disabled account shows the Disabled pill', async () =>
    {
        const { view } = await Harness.Make()
        assert.equal(Fixtures.Find(view.RowFor('bob'), StatusPill)[0].Kind, PillKind.Disabled)
        assert.equal(Fixtures.Find(view.RowFor('me'), StatusPill)[0].Kind, PillKind.Active)
    })

    it('disabling another account opens a ConfirmDialog with the consequences copy', async () =>
    {
        const { src, view } = await Harness.Make()
        Fixtures.Click(view, 'bob@x.io')
        await Fixtures.Settle()
        Fixtures.Click(view, 'Disable')
        await Fixtures.Settle()
        const dialog = view.ActiveConfirm
        assert.ok(dialog)
        assert.ok(dialog.Lines.some(l => l.includes("They are signed out everywhere and can't sign in.")))
        assert.ok(dialog.Lines.some(l => l.includes('Their records and history stay. Their tokens stop working.')))
        assert.equal(dialog.Actions?.[1]?.Variant, ButtonVariant.Danger)
        assert.equal(dialog.ConfirmEnabled, true)
        assert.deepEqual(src.disabled, [])
        dialog.Confirm()
        await Fixtures.Settle()
        await Fixtures.Settle()
        assert.deepEqual(src.disabled, ['bob'])
        assert.equal(view.ActiveConfirm, undefined)
    })

    it('cancelling the disable dialog does not disable', async () =>
    {
        const { src, view } = await Harness.Make()
        Fixtures.Click(view, 'bob@x.io')
        await Fixtures.Settle()
        Fixtures.Click(view, 'Disable')
        view.ActiveConfirm?.Cancel()
        await Fixtures.Settle()
        assert.equal(view.ActiveConfirm, undefined)
        assert.deepEqual(src.disabled, [])
    })

    it('self-disable routes through the self-lockout confirm', async () =>
    {
        const { src, view } = await Harness.Make()
        Fixtures.Click(view, 'me@x.io')
        await Fixtures.Settle()
        Fixtures.Click(view, 'Disable')
        await Fixtures.Settle()
        const first = view.ActiveConfirm
        assert.ok(first)
        assert.ok(first.Lines.some(l => l.includes(UsersAccessView.SelfDisableWarning)))
        assert.deepEqual(src.disabled, [])
        first.Cancel()
        await Fixtures.Settle()
        assert.equal(view.ActiveConfirm, undefined)
        assert.deepEqual(src.disabled, [])
        Fixtures.Click(view, 'Disable')
        await Fixtures.Settle()
        const second = view.ActiveConfirm as ConfirmDialog | undefined
        second?.Confirm()
        await Fixtures.Settle()
        await Fixtures.Settle()
        assert.deepEqual(src.disabled, ['me'])
        assert.equal(view.ActiveConfirm, undefined)
    })

    it('names the target account in the disable dialog', async () =>
    {
        const { view } = await Harness.Make()
        Fixtures.Click(view, 'bob@x.io')
        await Fixtures.Settle()
        Fixtures.Click(view, 'Disable')
        assert.ok(view.ActiveConfirm?.Lines.some(l => l.includes('bob@x.io')))
        view.ActiveConfirm?.Cancel()
        Fixtures.Click(view, 'me@x.io')
        await Fixtures.Settle()
        Fixtures.Click(view, 'Disable')
        await Fixtures.Settle()
        assert.ok(view.ActiveConfirm?.Lines.some(l => l.includes('me@x.io') && l.includes(UsersAccessView.SelfDisableWarning)))
    })

    it('does not switch environment or open a second dialog while a dialog is open', async () =>
    {
        const { src, view } = await Harness.Make()
        Fixtures.Click(view, 'bob@x.io')
        await Fixtures.Settle()
        Fixtures.Click(view, 'Disable')
        const dialog = view.ActiveConfirm
        assert.ok(dialog)
        Fixtures.Click(view, 'prod')
        await Fixtures.Settle()
        assert.deepEqual(src.snapshotCalls, ['dev'])
        Fixtures.Click(view, 'Disable')
        assert.equal(view.ActiveConfirm, dialog)
        dialog.Confirm()
        await Fixtures.Settle()
        await Fixtures.Settle()
        assert.deepEqual(src.disabled, ['bob'])
    })

    it('keeps the dialog hosted across a re-render', async () =>
    {
        const { view } = await Harness.Make()
        Fixtures.Click(view, 'bob@x.io')
        await Fixtures.Settle()
        Fixtures.Click(view, 'Disable')
        const dialog = view.ActiveConfirm
        view.Render()
        assert.equal(view.ActiveConfirm, dialog)
        assert.equal(Fixtures.Find(view, ConfirmDialog).length, 1)
    })

    it('Dispose clears an open dialog without throwing', async () =>
    {
        const { view } = await Harness.Make()
        Fixtures.Click(view, 'bob@x.io')
        await Fixtures.Settle()
        Fixtures.Click(view, 'Disable')
        assert.ok(view.ActiveConfirm)
        view.Dispose()
        assert.equal(view.ActiveConfirm, undefined)
        view.Dispose()
    })

    it('grants the picked role to the selected account', async () =>
    {
        const { src, view } = await Harness.Make()
        Fixtures.Click(view, 'bob@x.io')
        await Fixtures.Settle()
        Fixtures.Click(view, 'Editor')
        Fixtures.Click(view, 'Grant')
        await Fixtures.Settle()
        assert.deepEqual(src.granted, [{ subject: 'bob', role: 'Editor' }])
    })

    it('renders Loading, Empty, Error and NoEnvironment distinctly', async () =>
    {
        const loading = new UsersAccessView(new FakeSource(), 'me')
        assert.ok(Fixtures.Texts(loading).includes(UsersAccessView.LoadingText))

        const emptySrc = new FakeSource()
        emptySrc.snapshot = { accounts: [], grants: [] }
        const empty = (await Harness.Make(emptySrc)).view
        assert.ok(Fixtures.Texts(empty).includes(UsersAccessView.EmptyText))

        const errSrc = new FakeSource()
        errSrc.snapshotError = new TenantApiError(500, 'backend down')
        const err = (await Harness.Make(errSrc)).view
        assert.ok(Fixtures.Texts(err).includes('backend down'))

        const noEnvSrc = new FakeSource()
        noEnvSrc.envs = []
        const noEnv = (await Harness.Make(noEnvSrc)).view
        assert.ok(Fixtures.Texts(noEnv).includes(UsersAccessView.NoEnvironmentText))
    })
})
