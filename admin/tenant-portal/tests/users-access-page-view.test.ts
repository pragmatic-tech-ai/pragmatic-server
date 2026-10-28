import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { ScreenState } from '../src/kit/screen-host.js'
import { DeniedStatePanel } from '../src/kit/state-panels.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import type { AdminCapabilitiesDto, AdminSnapshotDto, EnvironmentDto, IssueTokenParams, ITenantNavigator, ITokensSource, IUsersAccessSource, SecurityModelDto, ServiceTokenSummaryDto, TokenIssuedDto } from '../src/tenant-types.js'
import type { ISecurityModelEnvSource } from '../src/security-model-view-model.js'
import { SecurityModelView } from '../src/security-model-view.js'
import { UsersAccessPageView } from '../src/users-access-page-view.js'

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

    public static Collect(node: unknown, out: unknown[] = []): unknown[]
    {
        out.push(node)
        const n = node as { Children?: Iterable<unknown> }
        for (const c of n.Children ?? [])
        {
            Fixtures.Collect(c, out)
        }
        return out
    }

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
        for (const c of n.Children ?? [])
        {
            out.push(...Fixtures.Texts(c))
        }
        return out
    }

    public static TabLabels(page: UsersAccessPageView): string[]
    {
        const strip = [...page.Tabs.Children][0]
        return Fixtures.Collect(strip).filter(n => n instanceof Button).map(b => Fixtures.Texts(b).join(''))
    }

    public static async Settle(): Promise<void>
    {
        await new Promise(r => setTimeout(r, 0))
    }
}

class FakeSource implements IUsersAccessSource, ISecurityModelEnvSource, ITokensSource
{
    public snapshotCalls: string[] = []
    public tokenCalls: string[] = []
    public modelCalls: string[] = []
    public tokenError: Error | undefined

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        return [{ name: 'dev' } as EnvironmentDto]
    }

    public async GetAdminSnapshot(env: string): Promise<AdminSnapshotDto>
    {
        this.snapshotCalls.push(env)
        throw new Error('no snapshot')
    }

    public async GetSecurityModel(env: string): Promise<SecurityModelDto | null>
    {
        this.modelCalls.push(env)
        return null
    }

    public async SetSecurityModel(): Promise<void> {}
    public async CreateAccount(): Promise<void> {}
    public async DisableAccount(): Promise<void> {}
    public async GrantRole(): Promise<void> {}
    public async RevokeRole(): Promise<void> {}

    public async ListTokens(env: string): Promise<ServiceTokenSummaryDto[]>
    {
        this.tokenCalls.push(env)
        if (this.tokenError !== undefined)
        {
            throw this.tokenError
        }
        return []
    }

    public async IssueToken(_env: string, _params: IssueTokenParams): Promise<TokenIssuedDto>
    {
        throw new Error('unused')
    }

    public async RevokeToken(): Promise<void> {}
}

class FakeNav implements ITenantNavigator
{
    public logins = 0
    public Caps: AdminCapabilitiesDto | undefined = undefined
    public Owner: string | undefined = undefined

    public ShowLogin(): void { this.logins++ }
    public ShowTree(): void {}
    public ShowHiveDetail(): void {}
    public ShowEnvironmentDetail(): void {}
    public ShowUsersAccess(): void {}
    public ShowServiceTokens(): void {}
    public ShowSection(_section: unknown): void {}
    public get Profile(): undefined { return undefined }
    public get Capabilities(): AdminCapabilitiesDto | undefined { return this.Caps }
    public get OwnerContact(): string | undefined { return this.Owner }
    public get Activity(): never { throw new Error('unused') }
    public OpenActivityDrawer(): void {}
}

class Harness
{
    public static Make(): { src: FakeSource; nav: FakeNav; page: UsersAccessPageView }
    {
        Fixtures.InitApp()
        const src = new FakeSource()
        const nav = new FakeNav()
        const page = new UsersAccessPageView(src, 'me')
        return { src, nav, page }
    }
}

describe('UsersAccessPageView', () =>
{
    it('shows three tabs: Users, Roles & permissions, Tokens', () =>
    {
        const { nav, page } = Harness.Make()
        page.AttachNavigator(nav)
        assert.deepEqual(Fixtures.TabLabels(page), ['Users', 'Roles & permissions', 'Tokens'])
        assert.ok(Fixtures.Collect(page).includes(page.Tabs))
        assert.equal(page.Tabs.ActiveContent, page.Users)
        assert.ok(page.Roles instanceof SecurityModelView)
    })

    it('shows the denied state instead of the tabs when access is withheld', () =>
    {
        const { nav, page } = Harness.Make()
        nav.Caps = { envs: true, adopt: true, access: false, settings: true }
        nav.Owner = 'owner@northwind.example'
        page.AttachNavigator(nav)
        assert.ok(page.DeniedHost)
        assert.equal(page.DeniedHost.State, ScreenState.Denied)
        const panel = Fixtures.Collect(page).find(n => n instanceof DeniedStatePanel) as DeniedStatePanel
        assert.ok(panel)
        assert.ok(panel.Heading.includes('Users & Access'))
        assert.ok(panel.BodyText.includes('Manage users & access'))
        assert.ok(panel.BodyText.includes('owner@northwind.example'))
        assert.ok(!Fixtures.Collect(page).includes(page.Tabs))
    })

    it('is permissive when capabilities are unknown', () =>
    {
        const { nav, page } = Harness.Make()
        page.AttachNavigator(nav)
        assert.equal(page.DeniedHost, undefined)
        assert.ok(Fixtures.Collect(page).includes(page.Tabs))
    })

    it('loads Users on mount and Tokens only on first activation', async () =>
    {
        const { src, nav, page } = Harness.Make()
        page.AttachNavigator(nav)
        await page.Refresh()
        await Fixtures.Settle()
        assert.equal(src.snapshotCalls.length, 1)
        assert.equal(src.tokenCalls.length, 0)
        assert.equal(src.modelCalls.length, 0)
        page.Tabs.Select(2)
        await Fixtures.Settle()
        assert.equal(src.tokenCalls.length, 1)
        page.Tabs.Select(0)
        page.Tabs.Select(2)
        await Fixtures.Settle()
        assert.equal(src.snapshotCalls.length, 1)
        assert.equal(src.tokenCalls.length, 1)
    })

    it('forwards the navigator to each embedded view', async () =>
    {
        const { src, nav, page } = Harness.Make()
        src.tokenError = new TenantApiError(TenantApiError.UnauthorizedStatus, 'no')
        page.AttachNavigator(nav)
        await page.Refresh()
        page.Tabs.Select(2)
        await Fixtures.Settle()
        assert.equal(nav.logins, 1)
    })

    it('Dispose disposes all three views', () =>
    {
        const { nav, page } = Harness.Make()
        page.AttachNavigator(nav)
        const disposed: string[] = []
        page.Users.Dispose = (): void => { disposed.push('users') }
        page.Roles.Dispose = (): void => { disposed.push('roles') }
        page.Tokens.Dispose = (): void => { disposed.push('tokens') }
        page.Dispose()
        assert.deepEqual(disposed, ['users', 'roles', 'tokens'])
    })
})
