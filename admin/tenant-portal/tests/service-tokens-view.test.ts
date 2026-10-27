import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { DataGridTextColumn } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid-column.js'
import { SelectionMode } from '@pragmatic-tech-ai/mural/framework/list/selector.js'
import type { ServiceTokenRow } from '../src/service-token-row.js'
import { ServiceTokensView } from '../src/service-tokens-view.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import type { EnvironmentDto, ITenantNavigator, IssueTokenParams, ITokensSource, ServiceTokenSummaryDto, TokenIssuedDto } from '../src/tenant-types.js'

class Fixtures
{
    public static readonly Secret = 'sk_live_SUPERSECRET_123'

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

    public static BoxOf(view: unknown, placeholder: string): { Text: string }
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

class FakeSource implements ITokensSource
{
    public envs: EnvironmentDto[] = [{ name: 'dev' } as EnvironmentDto, { name: 'prod' } as EnvironmentDto]
    public listEnvError: Error | undefined
    public listError: Error | undefined
    public issueError: Error | undefined
    public tokens: ServiceTokenSummaryDto[] = [
        { tokenRef: 'ref-1', principalId: 'svc-a', scopes: ['read', 'write'], expiresAt: null, revoked: false },
        { tokenRef: 'ref-2', principalId: 'svc-b', scopes: ['read'], expiresAt: null, revoked: true },
    ]
    public listCalls: string[] = []
    public issued: IssueTokenParams[] = []
    public revoked: string[] = []

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        if (this.listEnvError !== undefined)
        {
            throw this.listEnvError
        }
        return this.envs
    }

    public async ListTokens(env: string): Promise<ServiceTokenSummaryDto[]>
    {
        this.listCalls.push(env)
        if (this.listError !== undefined)
        {
            throw this.listError
        }
        return this.tokens
    }

    public async IssueToken(_env: string, params: IssueTokenParams): Promise<TokenIssuedDto>
    {
        if (this.issueError !== undefined)
        {
            throw this.issueError
        }
        this.issued.push(params)
        return { tokenRef: 'ref-new', token: Fixtures.Secret, principalId: params.principalId, scopes: params.scopes, expiresAt: null }
    }

    public async RevokeToken(_env: string, tokenRef: string): Promise<void>
    {
        this.revoked.push(tokenRef)
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
}

class Harness
{
    public static async Make(src = new FakeSource()): Promise<{ src: FakeSource; view: ServiceTokensView }>
    {
        const view = new ServiceTokensView(src)
        await view.Refresh()
        return { src, view }
    }

    public static async Issue(view: ServiceTokensView): Promise<void>
    {
        Fixtures.BoxOf(view, ServiceTokensView.PrincipalPlaceholder).Text = 'svc-new'
        Fixtures.BoxOf(view, ServiceTokensView.ScopesPlaceholder).Text = 'read, write  admin'
        Fixtures.Click(view, ServiceTokensView.IssueLabel)
        await Fixtures.Settle()
    }
}

describe('ServiceTokensView', () =>
{
    it('configures five columns, single selection and rows from the snapshot', async () =>
    {
        const { view } = await Harness.Make()
        const grid = view.Grid
        const cols = [...grid.Columns] as DataGridTextColumn[]
        assert.equal(cols.length, 5)
        assert.ok(cols.every(c => c instanceof DataGridTextColumn))
        assert.deepEqual(cols.map(c => c.BindingPath), ['TokenRef', 'PrincipalId', 'ScopesText', 'ExpiresText', 'StatusText'])
        assert.equal(grid.SelectionMode, SelectionMode.Single)
        const rows = grid.ItemsSource as ServiceTokenRow[]
        assert.deepEqual(rows.map(r => [r.TokenRef, r.ScopesText, r.StatusText]), [['ref-1', 'read, write', 'Active'], ['ref-2', 'read', 'Revoked']])
    })

    it('renders one button per environment and reloads on a different pick', async () =>
    {
        const { src, view } = await Harness.Make()
        const labels = Fixtures.Labels(view)
        assert.ok(labels.includes(ServiceTokensView.SelectedMark + 'dev'))
        assert.ok(labels.includes('prod'))
        Fixtures.Click(view, 'prod')
        await Fixtures.Settle()
        assert.deepEqual(src.listCalls, ['dev', 'prod'])
    })

    it('renders the issue form with principal, scopes, duration strip and Issue', async () =>
    {
        const { view } = await Harness.Make()
        Fixtures.BoxOf(view, ServiceTokensView.PrincipalPlaceholder)
        Fixtures.BoxOf(view, ServiceTokensView.ScopesPlaceholder)
        const labels = Fixtures.Labels(view)
        assert.ok(labels.includes(ServiceTokensView.IssueLabel))
        assert.ok(labels.includes(ServiceTokensView.OneHourLabel))
        assert.ok(labels.includes(ServiceTokensView.SelectedMark + ServiceTokensView.OneDayLabel))
        assert.ok(labels.includes(ServiceTokensView.ThirtyDaysLabel))
        assert.ok(labels.includes(ServiceTokensView.NeverLabel))
    })

    it('clicking a duration button selects it', async () =>
    {
        const { view } = await Harness.Make()
        Fixtures.Click(view, ServiceTokensView.ThirtyDaysLabel)
        const labels = Fixtures.Labels(view)
        assert.ok(labels.includes(ServiceTokensView.SelectedMark + ServiceTokensView.ThirtyDaysLabel))
        assert.ok(labels.includes(ServiceTokensView.OneDayLabel))
    })

    it('issues with parsed scopes and mapped expiry, clears the form, and reveals the secret', async () =>
    {
        const { src, view } = await Harness.Make()
        Fixtures.Click(view, ServiceTokensView.ThirtyDaysLabel)
        await Harness.Issue(view)
        assert.deepEqual(src.issued, [{ principalId: 'svc-new', scopes: ['read', 'write', 'admin'], expiresInSeconds: 2592000 }])
        assert.equal(Fixtures.BoxOf(view, ServiceTokensView.PrincipalPlaceholder).Text, '')
        assert.equal(Fixtures.BoxOf(view, ServiceTokensView.ScopesPlaceholder).Text, '')
        const texts = Fixtures.Texts(view)
        assert.ok(texts.includes(Fixtures.Secret))
        assert.ok(texts.includes(ServiceTokensView.RefLabel + 'ref-new'))
        assert.ok(Fixtures.Labels(view).includes(ServiceTokensView.DismissLabel))
    })

    it('never carries the secret into the grid, and removes it from every node after Dismiss', async () =>
    {
        const { view } = await Harness.Make()
        await Harness.Issue(view)
        const gridHas = (): boolean => JSON.stringify(view.Grid.ItemsSource).includes(Fixtures.Secret)
        assert.equal(gridHas(), false)
        for (const r of view.Grid.ItemsSource as ServiceTokenRow[])
        {
            for (const v of [r.TokenRef, r.PrincipalId, r.ScopesText, r.ExpiresText, r.StatusText])
            {
                assert.equal(v.includes(Fixtures.Secret), false)
            }
        }
        assert.ok(Fixtures.Texts(view).includes(Fixtures.Secret))
        Fixtures.Click(view, ServiceTokensView.DismissLabel)
        assert.equal(Fixtures.Texts(view).some(t => t.includes(Fixtures.Secret)), false)
        assert.equal(gridHas(), false)
        assert.equal(Fixtures.Labels(view).includes(ServiceTokensView.DismissLabel), false)
    })

    it('revokes the selected row after an inline confirm', async () =>
    {
        const { src, view } = await Harness.Make()
        assert.equal(Fixtures.Labels(view).includes(ServiceTokensView.RevokeLabel), false)
        const rows = view.Grid.ItemsSource as ServiceTokenRow[]
        view.Grid.SelectedItem = rows[0]
        assert.ok(Fixtures.Labels(view).includes(ServiceTokensView.RevokeLabel))
        Fixtures.Click(view, ServiceTokensView.RevokeLabel)
        assert.ok(Fixtures.Labels(view).includes(ServiceTokensView.ConfirmRevokeLabel))
        assert.deepEqual(src.revoked, [])
        Fixtures.Click(view, ServiceTokensView.ConfirmRevokeLabel)
        await Fixtures.Settle()
        assert.deepEqual(src.revoked, ['ref-1'])
    })

    it('cancelling the confirm revokes nothing', async () =>
    {
        const { src, view } = await Harness.Make()
        view.Grid.SelectedItem = (view.Grid.ItemsSource as ServiceTokenRow[])[0]
        Fixtures.Click(view, ServiceTokensView.RevokeLabel)
        Fixtures.Click(view, ServiceTokensView.CancelLabel)
        await Fixtures.Settle()
        assert.deepEqual(src.revoked, [])
        assert.ok(Fixtures.Labels(view).includes(ServiceTokensView.RevokeLabel))
    })

    it('renders Empty, NoEnvironment and Error states distinctly', async () =>
    {
        const empty = new FakeSource()
        empty.tokens = []
        const e = await Harness.Make(empty)
        assert.ok(Fixtures.Texts(e.view).includes(ServiceTokensView.EmptyText))

        const none = new FakeSource()
        none.envs = []
        const n = await Harness.Make(none)
        assert.ok(Fixtures.Texts(n.view).includes(ServiceTokensView.NoEnvironmentText))

        const bad = new FakeSource()
        bad.listError = new Error('boom')
        const b = await Harness.Make(bad)
        const texts = Fixtures.Texts(b.view)
        assert.ok(texts.includes('boom'))
        assert.equal(texts.includes(ServiceTokensView.EmptyText), false)
        assert.equal(texts.includes(ServiceTokensView.NoEnvironmentText), false)
    })

    it('renders Loading before the first refresh', () =>
    {
        const view = new ServiceTokensView(new FakeSource())
        assert.ok(Fixtures.Texts(view).includes(ServiceTokensView.LoadingText))
    })

    it('a 401 without an attached navigator surfaces as an error line', async () =>
    {
        const src = new FakeSource()
        src.listEnvError = new TenantApiError(TenantApiError.UnauthorizedStatus, 'no')
        const { view } = await Harness.Make(src)
        assert.equal(Fixtures.Texts(view).some(t => t.includes('error: ')), true)
    })

    it('keeps the typed text and shows no secret when issuing fails', async () =>
    {
        const src = new FakeSource()
        src.issueError = new Error('nope')
        const { view } = await Harness.Make(src)
        await Harness.Issue(view)
        assert.equal(Fixtures.BoxOf(view, ServiceTokensView.PrincipalPlaceholder).Text, 'svc-new')
        assert.equal(Fixtures.BoxOf(view, ServiceTokensView.ScopesPlaceholder).Text, 'read, write  admin')
        assert.equal(Fixtures.Labels(view).includes(ServiceTokensView.DismissLabel), false)
        assert.ok(Fixtures.Texts(view).includes('nope'))
    })

    it('Dispose clears the issued secret from the view', async () =>
    {
        const { view } = await Harness.Make()
        await Harness.Issue(view)
        assert.ok(Fixtures.Texts(view).includes(Fixtures.Secret))
        view.Dispose()
        assert.equal(Fixtures.Texts(view).some(t => t.includes(Fixtures.Secret)), false)
    })

    it('selecting another row cancels a pending revoke', async () =>
    {
        const { src, view } = await Harness.Make()
        const rows = view.Grid.ItemsSource as ServiceTokenRow[]
        view.Grid.SelectedItem = rows[0]
        Fixtures.Click(view, ServiceTokensView.RevokeLabel)
        view.Grid.SelectedItem = rows[1]
        assert.equal(Fixtures.Labels(view).includes(ServiceTokensView.ConfirmRevokeLabel), false)
        assert.deepEqual(src.revoked, [])
    })

    it('reload keeps the selected token section only while the row still exists', async () =>
    {
        const { src, view } = await Harness.Make()
        view.Grid.SelectedItem = (view.Grid.ItemsSource as ServiceTokenRow[])[0]
        assert.ok(Fixtures.Texts(view).includes(ServiceTokensView.SelectedHeading + 'ref-1'))
        src.tokens = [src.tokens[1]]
        Fixtures.Click(view, 'prod')
        await Fixtures.Settle()
        assert.equal(Fixtures.Texts(view).some(t => t.startsWith(ServiceTokensView.SelectedHeading)), false)
    })

    it('a 401 with a navigator attached routes to login', async () =>
    {
        const src = new FakeSource()
        src.issueError = new TenantApiError(TenantApiError.UnauthorizedStatus, 'no')
        const { view } = await Harness.Make(src)
        const nav = new Nav()
        view.AttachNavigator(nav)
        await Harness.Issue(view)
        assert.equal(nav.logins, 1)
    })
})
