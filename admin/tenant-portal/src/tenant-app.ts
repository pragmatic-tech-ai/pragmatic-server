import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { EnvironmentDetailView } from './environment-detail-view.js'
import { HiveDetailView } from './hive-detail-view.js'
import { TenantApiClient } from './tenant-api-client.js'
import { TenantTreeView } from './tenant-tree-view.js'
import { TenantTreeViewModel } from './tenant-tree-view-model.js'
import { TenantViewBase } from './tenant-view-base.js'
import { TenantEventType } from './tenant-types.js'
import type { EnvironmentDto, HiveDto, ITenantNavigator, ITenantView, SessionDto, TenantEvent } from './tenant-types.js'
import { ServiceTokensView } from './service-tokens-view.js'
import { UsersAccessView } from './users-access-view.js'

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
    public static readonly EmptySelectionText = 'Select a hive or environment'
    public static readonly UsersAccessLabel = 'Users & Access'
    public static readonly ServiceTokensLabel = 'Service Tokens'

    private readonly client: TenantApiClient
    private readonly topBar = new StackPanel()
    private readonly tenantName = new TextBlock()
    private readonly body = new StackPanel()
    private readonly treeHost = new StackPanel()
    private readonly detailHost = new StackPanel()
    private current: ITenantView | undefined
    // Name of the environment the detail pane is showing, so a delete of it swaps the pane back rather than refreshing a gone env.
    private currentEnvName: string | undefined
    // Operator's principal from the Boot session; UsersAccessView uses it to guard self-disable.
    private currentPrincipalId = ''
    private tree: TenantTreeView | undefined
    private eventUnsub: (() => void) | undefined

    public constructor(client: TenantApiClient = new TenantApiClient())
    {
        super()
        this.client = client
        const title = new TextBlock()
        title.Text = TenantApp.TitleText
        this.topBar.Orientation = Orientation.Horizontal
        this.topBar.AddChild(title)
        this.topBar.AddChild(this.tenantName)
        this.topBar.AddChild(TenantViewBase.MakeButton(TenantApp.UsersAccessLabel, () => this.ShowUsersAccess()))
        this.topBar.AddChild(TenantViewBase.MakeButton(TenantApp.ServiceTokensLabel, () => this.ShowServiceTokens()))
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
        this.currentPrincipalId = session.principalId
        this.eventUnsub?.()
        this.eventUnsub = this.client.OnEvent(ev => this.OnTenantEvent(ev))
        this.ShowTree()
    }

    public ShowLogin(): void
    {
        this.Teardown()
        this.client.BeginLogin()
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
        this.Show(new HiveDetailView(this.client, hive))
    }

    public ShowEnvironmentDetail(env: EnvironmentDto): void
    {
        this.Show(new EnvironmentDetailView(this.client, env, env.hiveId))
        this.currentEnvName = env.name
    }

    public ShowUsersAccess(): void
    {
        this.Show(new UsersAccessView(this.client, this.currentPrincipalId))
    }

    public ShowServiceTokens(): void
    {
        this.Show(new ServiceTokensView(this.client))
    }

    public ShowRolesPrivileges(): void
    {
        // The Roles & Privileges view is attached in a later task.
    }

    public get CurrentPrincipalId(): string
    {
        return this.currentPrincipalId
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
        this.currentPrincipalId = ''
    }

    private OnTenantEvent(ev: TenantEvent): void
    {
        this.tree?.ApplyEvent(ev)
        if (ev.type === TenantEventType.EnvironmentDeleted && ev.environmentName === this.currentEnvName)
        {
            // The open environment was deleted: swap the pane back to the placeholder rather than refreshing a gone env.
            this.Show(new DetailPlaceholderView(TenantApp.EmptySelectionText))
            return
        }
        void this.current?.Refresh()
    }

    // Swaps the detail pane: disposes the outgoing view, mounts the incoming one.
    private Show(view: TenantViewBase): void
    {
        this.current?.Dispose?.()
        this.Clear(this.detailHost)
        this.current = view
        this.currentEnvName = undefined
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
