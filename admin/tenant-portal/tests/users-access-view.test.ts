import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { DataGridTextColumn } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid-column.js'
import { SelectionMode } from '@pragmatic-tech-ai/mural/framework/list/selector.js'
import { AccountRow } from '../src/account-row.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import { GridLength, GridUnitType } from '@pragmatic-tech-ai/mural/basic/panels/grid.js'
import type { AdminSnapshotDto, CreateAccountParams, EnvironmentDto, GrantMutationDto, ITenantNavigator, IUsersAccessSource } from '../src/tenant-types.js'
import { UsersAccessView } from '../src/users-access-view.js'

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
    public ShowRolesPrivileges(): void {}
    public ShowFieldSecurity(): void {}
    public ShowSection(_section: unknown): void {}
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
    it('configures four columns, single selection and rows from the snapshot', async () =>
    {
        const { view } = await Harness.Make()
        const grid = view.Grid
        const cols = [...grid.Columns] as DataGridTextColumn[]
        assert.equal(cols.length, 4)
        assert.ok(cols.every(c => c instanceof DataGridTextColumn))
        assert.deepEqual(cols.map(c => c.BindingPath), ['Email', 'PrincipalId', 'Status', 'RolesText'])
        assert.equal(grid.SelectionMode, SelectionMode.Single)
        const rows = grid.ItemsSource as AccountRow[]
        assert.deepEqual(rows.map(r => [r.Email, r.Status, r.RolesText]), [['me@x.io', 'Active', 'Owner'], ['bob@x.io', 'Disabled', 'Viewer']])
    })

    it('renders one env button per environment and reloads on pick', async () =>
    {
        const { src, view } = await Harness.Make()
        const labels = Fixtures.Labels(view)
        assert.ok(labels.includes('● dev'))
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
        view.Grid.SelectedItem = (view.Grid.ItemsSource as AccountRow[])[1]
        await Fixtures.Settle()
        src.mutationError = new TenantApiError(401, 'expired')
        Fixtures.Click(view, 'Disable')
        await Fixtures.Settle()
        await Fixtures.Settle()
        assert.equal(nav.logins, 1)
    })

    it('uses the expected column widths', async () =>
    {
        const { view } = await Harness.Make()
        const w = ([...view.Grid.Columns] as DataGridTextColumn[]).map(c => c.Width)
        assert.deepEqual(w.map(x => [x.Value, x.UnitType]), [[2, GridUnitType.Star], [2, GridUnitType.Star], [GridLength.Auto.Value, GridUnitType.Auto], [3, GridUnitType.Star]])
    })

    it('Dispose removes the selection listener and disposes the grid', async () =>
    {
        const { view } = await Harness.Make()
        const grid = view.Grid as unknown as { RemoveSelectionChangedListener: (l: () => void) => void; dispose: () => void }
        const calls: string[] = []
        const rm = grid.RemoveSelectionChangedListener.bind(grid)
        const ds = grid.dispose.bind(grid)
        grid.RemoveSelectionChangedListener = l => { calls.push('remove'); rm(l) }
        grid.dispose = () => { calls.push('dispose'); ds() }
        view.Dispose()
        assert.deepEqual(calls, ['remove', 'dispose'])
    })

    it('confirms self-revoke and revokes non-self directly', async () =>
    {
        const { src, view } = await Harness.Make()
        view.Grid.SelectedItem = (view.Grid.ItemsSource as AccountRow[])[1]
        await Fixtures.Settle()
        Fixtures.Click(view, 'Revoke')
        await Fixtures.Settle()
        await Fixtures.Settle()
        assert.deepEqual(src.revoked.map(r => r.subject), ['bob'])
        view.Grid.SelectedItem = (view.Grid.ItemsSource as AccountRow[])[0]
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
        view.Grid.SelectedItem = (view.Grid.ItemsSource as AccountRow[])[0]
        await Fixtures.Settle()
        Fixtures.Click(view, 'Revoke')
        await Fixtures.Settle()
        assert.equal(Fixtures.Labels(view).filter(l => l === 'Confirm revoke').length, 1)
        assert.equal(Fixtures.Labels(view).filter(l => l === 'Revoke').length, 1)
    })

    it('keeps the selected-account section across a reload', async () =>
    {
        const { src, view } = await Harness.Make()
        const before = view.Grid.ItemsSource as AccountRow[]
        view.Grid.SelectedItem = before[1]
        await Fixtures.Settle()
        Fixtures.Click(view, 'Grant')
        await Fixtures.Settle()
        await Fixtures.Settle()
        assert.equal(src.granted.length, 1)
        assert.notEqual(view.Grid.ItemsSource, before)
        assert.ok(Fixtures.Texts(view).includes(UsersAccessView.SelectedHeading + 'bob'))
    })

    it('adapts grid selection to the view model', async () =>
    {
        const { view } = await Harness.Make()
        const rows = view.Grid.ItemsSource as AccountRow[]
        view.Grid.SelectedItem = rows[1]
        await Fixtures.Settle()
        assert.ok(Fixtures.Texts(view).includes(UsersAccessView.SelectedHeading + 'bob'))
    })

    it('shows the selected-account section with grants, revoke and disable', async () =>
    {
        const { src, view } = await Harness.Make()
        const rows = view.Grid.ItemsSource as AccountRow[]
        view.Grid.SelectedItem = rows[1]
        await Fixtures.Settle()
        assert.ok(Fixtures.Texts(view).includes('Viewer dev'))
        const labels = Fixtures.Labels(view)
        assert.ok(labels.includes('Revoke'))
        assert.ok(labels.includes('Disable'))
        Fixtures.Click(view, 'Disable')
        await Fixtures.Settle()
        assert.deepEqual(src.disabled, ['bob'])
        assert.ok(!Fixtures.Labels(view).includes('Confirm disable'))
    })

    it('confirms disable only for the current operator', async () =>
    {
        const { src, view } = await Harness.Make()
        const rows = view.Grid.ItemsSource as AccountRow[]
        view.Grid.SelectedItem = rows[0]
        await Fixtures.Settle()
        Fixtures.Click(view, 'Disable')
        await Fixtures.Settle()
        assert.ok(Fixtures.Labels(view).includes('Confirm disable'))
        assert.ok(Fixtures.Labels(view).includes('Cancel'))
        assert.deepEqual(src.disabled, [])
        Fixtures.Click(view, 'Cancel')
        await Fixtures.Settle()
        assert.ok(Fixtures.Labels(view).includes('Disable'))
        Fixtures.Click(view, 'Disable')
        await Fixtures.Settle()
        Fixtures.Click(view, 'Confirm disable')
        await Fixtures.Settle()
        await Fixtures.Settle()
        assert.deepEqual(src.disabled, ['me'])
    })

    it('grants the picked role to the selected account', async () =>
    {
        const { src, view } = await Harness.Make()
        const rows = view.Grid.ItemsSource as AccountRow[]
        view.Grid.SelectedItem = rows[1]
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
