import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { DataGridTextColumn } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid-column.js'
import { SelectionMode } from '@pragmatic-tech-ai/mural/framework/list/selector.js'
import { AccountRow } from '../src/account-row.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import type { AdminSnapshotDto, CreateAccountParams, EnvironmentDto, GrantMutationDto, IUsersAccessSource } from '../src/tenant-types.js'
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
        this.created.push(params)
    }

    public async DisableAccount(_env: string, principalId: string): Promise<void>
    {
        this.disabled.push(principalId)
    }

    public async GrantRole(_env: string, grant: GrantMutationDto): Promise<void>
    {
        this.granted.push(grant)
    }

    public async RevokeRole(_env: string, grant: GrantMutationDto): Promise<void>
    {
        this.revoked.push(grant)
    }
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

    it('has a create form and never echoes the password after create', async () =>
    {
        const { src, view } = await Harness.Make()
        assert.ok(Fixtures.Labels(view).includes('Create'))
        Harness.BoxOf(view, UsersAccessView.EmailPlaceholder).Text = 'n@x.io'
        Harness.BoxOf(view, UsersAccessView.PrincipalPlaceholder).Text = 'n'
        Harness.BoxOf(view, UsersAccessView.PasswordPlaceholder).Text = 'hunter2-secret'
        Fixtures.Click(view, 'Create')
        await Fixtures.Settle()
        await Fixtures.Settle()
        assert.deepEqual(src.created, [{ email: 'n@x.io', principalId: 'n', password: 'hunter2-secret' }])
        assert.equal(Harness.BoxOf(view, UsersAccessView.PasswordPlaceholder).Text, '')
        assert.ok(!Fixtures.Texts(view).includes('hunter2-secret'))
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
