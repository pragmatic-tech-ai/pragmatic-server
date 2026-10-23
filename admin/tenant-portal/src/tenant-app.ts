import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { TenantApiClient } from './tenant-api-client.js'
import { TenantTreeView } from './tenant-tree-view.js'
import { TenantTreeViewModel } from './tenant-tree-view-model.js'
import { TenantViewBase } from './tenant-view-base.js'
import type { EnvironmentDto, HiveDto, ITenantNavigator, ITenantView, SessionDto, TenantEvent } from './tenant-types.js'

// Reads the page location and session storage; injected so tests need no browser.
export interface ITenantEnvironment
{
    QueryTenant(): string | null
    StoredTenant(): string | null
    StoreTenant(id: string): void
}

export class BrowserTenantEnvironment implements ITenantEnvironment
{
    private static readonly TenantParam = 'tenant'
    private static readonly StorageKey = 'pragmatic.tenant-portal.tenant'

    public QueryTenant(): string | null
    {
        const loc = (globalThis as { location?: { search?: string } }).location
        if (loc?.search === undefined)
        {
            return null
        }
        const value = new URLSearchParams(loc.search).get(BrowserTenantEnvironment.TenantParam)
        return value !== null && value !== '' ? value : null
    }

    public StoredTenant(): string | null
    {
        const store = (globalThis as { sessionStorage?: Storage }).sessionStorage
        return store?.getItem(BrowserTenantEnvironment.StorageKey) ?? null
    }

    public StoreTenant(id: string): void
    {
        const store = (globalThis as { sessionStorage?: Storage }).sessionStorage
        store?.setItem(BrowserTenantEnvironment.StorageKey, id)
    }
}

// Minimal detail view until the hive / environment detail views land.
class DetailPlaceholderView extends TenantViewBase
{
    public constructor(text: string)
    {
        super()
        const t = new TextBlock()
        t.Text = text
        this.AddChild(t)
    }

    public Refresh(): void
    {
    }
}

// Root shell: auth-gated boot, top bar, and a tree + detail two-pane frame.
export class TenantApp extends StackPanel implements ITenantNavigator
{
    public static readonly TitleText = 'Pragmatic Tenant Admin'
    public static readonly LogoutLabel = 'Logout'
    public static readonly ContinueLabel = 'Continue'
    public static readonly PromptText = 'Enter your tenant'
    public static readonly EmptySelectionText = 'Select a hive or environment'

    private readonly client: TenantApiClient
    private readonly environment: ITenantEnvironment
    private readonly topBar = new StackPanel()
    private readonly tenantName = new TextBlock()
    private readonly body = new StackPanel()
    private readonly treeHost = new StackPanel()
    private readonly detailHost = new StackPanel()
    private current: ITenantView | undefined
    private tree: TenantTreeView | undefined
    private eventUnsub: (() => void) | undefined

    public constructor(client: TenantApiClient = new TenantApiClient(), environment: ITenantEnvironment = new BrowserTenantEnvironment())
    {
        super()
        this.client = client
        this.environment = environment
        const title = new TextBlock()
        title.Text = TenantApp.TitleText
        this.topBar.Orientation = Orientation.Horizontal
        this.topBar.AddChild(title)
        this.topBar.AddChild(this.tenantName)
        this.topBar.AddChild(TenantViewBase.MakeButton(TenantApp.LogoutLabel, () => { void this.Logout() }))
        this.body.Orientation = Orientation.Horizontal
        this.body.AddChild(this.treeHost)
        this.body.AddChild(this.detailHost)
        this.AddChild(this.topBar)
        this.AddChild(this.body)
    }

    // Probes the session cookie: signed in -> tree, otherwise (null or any failure) -> login.
    public async Boot(): Promise<void>
    {
        let session: SessionDto | null
        try
        {
            session = await this.client.Session()
        }
        catch
        {
            session = null
        }
        if (session === null)
        {
            this.ShowLogin()
            return
        }
        this.tenantName.Text = session.email ?? session.tenantId
        this.eventUnsub?.()
        this.eventUnsub = this.client.OnEvent(ev => this.OnTenantEvent(ev))
        this.ShowTree()
    }

    public ShowLogin(): void
    {
        this.Teardown()
        const fromQuery = this.environment.QueryTenant()
        if (fromQuery !== null)
        {
            this.environment.StoreTenant(fromQuery)
        }
        const id = fromQuery ?? this.environment.StoredTenant()
        if (id !== null)
        {
            this.client.BeginLogin(id)
            return
        }
        this.ShowPrompt()
    }

    public ShowTree(): void
    {
        this.Clear(this.treeHost)
        this.tree = new TenantTreeView(new TenantTreeViewModel(this.client))
        this.tree.AttachNavigator(this)
        this.treeHost.AddChild(this.tree)
        void this.tree.Refresh()
        this.Show(new DetailPlaceholderView(TenantApp.EmptySelectionText))
    }

    public ShowHiveDetail(hive: HiveDto): void
    {
        this.Show(new DetailPlaceholderView(hive.displayName))
    }

    public ShowEnvironmentDetail(env: EnvironmentDto): void
    {
        this.Show(new DetailPlaceholderView(env.name))
    }

    private ShowPrompt(): void
    {
        const prompt = new StackPanel()
        const label = new TextBlock()
        label.Text = TenantApp.PromptText
        const box = new TextBox()
        prompt.AddChild(label)
        prompt.AddChild(box)
        prompt.AddChild(TenantViewBase.MakeButton(TenantApp.ContinueLabel, () => this.Continue(box.Text)))
        this.Clear(this.treeHost)
        this.Clear(this.detailHost)
        this.detailHost.AddChild(prompt)
    }

    private Continue(raw: string): void
    {
        const id = raw.trim()
        if (id === '')
        {
            return
        }
        this.environment.StoreTenant(id)
        this.client.BeginLogin(id)
    }

    private async Logout(): Promise<void>
    {
        this.Teardown()
        try
        {
            await this.client.Logout()
        }
        catch
        {
            // Fall through: drop to login regardless.
        }
        this.ShowLogin()
    }

    private Teardown(): void
    {
        this.current?.Dispose?.()
        this.current = undefined
        this.tree = undefined
        this.eventUnsub?.()
        this.eventUnsub = undefined
        this.tenantName.Text = ''
    }

    private OnTenantEvent(ev: TenantEvent): void
    {
        this.tree?.ApplyEvent(ev)
        void this.current?.Refresh()
    }

    // Swaps the detail pane: disposes the outgoing view, mounts the incoming one.
    private Show(view: TenantViewBase): void
    {
        this.current?.Dispose?.()
        this.Clear(this.detailHost)
        this.current = view
        view.AttachNavigator(this)
        this.detailHost.AddChild(view)
        void view.Refresh()
    }

    private Clear(host: StackPanel): void
    {
        for (const child of [...host.Children])
        {
            host.RemoveChild(child)
        }
    }
}
