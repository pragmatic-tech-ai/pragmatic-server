import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import type { AdminCapabilitiesDto, AdminSnapshotDto, EnvironmentDto, ITenantNavigator, IUsersAccessSource } from '../src/tenant-types.js'
import { ScreenState } from '../src/kit/screen-host.js'
import { DeniedStatePanel } from '../src/kit/state-panels.js'
import { UsersAccessHubView } from '../src/users-access-hub-view.js'
import { UsersAccessView } from '../src/users-access-view.js'

class Walk
{
    public static Collect(node: unknown, out: unknown[] = []): unknown[]
    {
        out.push(node)
        const n = node as { Children?: Iterable<unknown> }
        for (const c of n.Children ?? [])
        {
            Walk.Collect(c, out)
        }
        return out
    }

    public static Label(b: Button): string
    {
        return Walk.Collect(b.Content).filter(x => x instanceof TextBlock).map(x => (x as TextBlock).Text).join('')
    }

    public static Click(root: unknown, label: string): void
    {
        const b = Walk.Collect(root).find(n => n instanceof Button && Walk.Label(n) === label)
        assert.ok(b, 'button ' + label)
        for (const h of (b as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
    }
}

class FakeSource implements IUsersAccessSource
{
    public ListEnvironments(): Promise<EnvironmentDto[]>
    {
        return Promise.resolve([])
    }

    public GetAdminSnapshot(): Promise<AdminSnapshotDto>
    {
        return Promise.reject(new Error('unused'))
    }

    public CreateAccount(): Promise<void>
    {
        return Promise.resolve()
    }

    public DisableAccount(): Promise<void>
    {
        return Promise.resolve()
    }

    public GrantRole(): Promise<void>
    {
        return Promise.resolve()
    }

    public RevokeRole(): Promise<void>
    {
        return Promise.resolve()
    }
}

class FakeNav implements ITenantNavigator
{
    public calls: string[] = []

    public ShowLogin(): void { this.calls.push('login') }
    public ShowTree(): void { this.calls.push('tree') }
    public ShowHiveDetail(): void { this.calls.push('hive') }
    public ShowEnvironmentDetail(): void { this.calls.push('env') }
    public ShowUsersAccess(): void { this.calls.push('users') }
    public ShowServiceTokens(): void { this.calls.push('tokens') }
    public ShowRolesPrivileges(): void { this.calls.push('roles') }
    public ShowFieldSecurity(): void { this.calls.push('field') }
    public ShowSection(_section: unknown): void {}
    public get Profile(): undefined { return undefined }
    public Caps: AdminCapabilitiesDto | undefined = undefined
    public Owner: string | undefined = undefined
    public get Capabilities(): AdminCapabilitiesDto | undefined { return this.Caps }
    public get OwnerContact(): string | undefined { return this.Owner }
}

class Caps
{
    public static With(access: boolean): AdminCapabilitiesDto
    {
        return { envs: true, adopt: true, access, settings: true }
    }
}

describe('UsersAccessHubView', () =>
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

    it('shows a UsersAccessView by default', () =>
    {
        const hub = new UsersAccessHubView(new FakeSource(), 'me')
        assert.ok(hub.Active instanceof UsersAccessView)
        assert.ok(Walk.Collect(hub).includes(hub.Active))
    })

    it('routes each button to the matching navigator method exactly once', () =>
    {
        const hub = new UsersAccessHubView(new FakeSource(), 'me')
        const nav = new FakeNav()
        hub.AttachNavigator(nav)
        Walk.Click(hub, UsersAccessHubView.ServiceTokensLabel)
        assert.deepEqual(nav.calls, ['tokens'])
        Walk.Click(hub, UsersAccessHubView.RolesPrivilegesLabel)
        assert.deepEqual(nav.calls, ['tokens', 'roles'])
        Walk.Click(hub, UsersAccessHubView.FieldSecurityLabel)
        assert.deepEqual(nav.calls, ['tokens', 'roles', 'field'])
    })

    it('shows the Denied state, with the owner contact, when access is withheld', () =>
    {
        const hub = new UsersAccessHubView(new FakeSource(), 'me')
        const nav = new FakeNav()
        nav.Caps = Caps.With(false)
        nav.Owner = 'owner@northwind.example'
        hub.AttachNavigator(nav)
        assert.ok(hub.DeniedHost)
        assert.equal(hub.DeniedHost.State, ScreenState.Denied)
        const panel = Walk.Collect(hub).find(n => n instanceof DeniedStatePanel) as DeniedStatePanel
        assert.ok(panel)
        assert.ok(panel.Heading.includes('Users & Access'))
        assert.ok(panel.BodyText.includes('Manage users & access'))
        assert.ok(panel.BodyText.includes('owner@northwind.example'))
        const all = Walk.Collect(hub)
        assert.ok(!all.includes(hub.Active))
        assert.ok(!all.some(n => n instanceof Button))
    })

    it('shows the normal body when access is granted', () =>
    {
        const hub = new UsersAccessHubView(new FakeSource(), 'me')
        const nav = new FakeNav()
        nav.Caps = Caps.With(true)
        hub.AttachNavigator(nav)
        const all = Walk.Collect(hub)
        assert.equal(hub.DeniedHost, undefined)
        assert.ok(all.includes(hub.Active))
        assert.ok(all.some(n => n instanceof Button))
        assert.ok(!all.some(n => n instanceof DeniedStatePanel))
    })

    it('treats an unknown profile (undefined capabilities) as allowed', () =>
    {
        const hub = new UsersAccessHubView(new FakeSource(), 'me')
        hub.AttachNavigator(new FakeNav())
        const all = Walk.Collect(hub)
        assert.equal(hub.DeniedHost, undefined)
        assert.ok(all.includes(hub.Active))
        assert.ok(!all.some(n => n instanceof DeniedStatePanel))
    })

    it('Refresh and Dispose do not throw when denied', async () =>
    {
        const hub = new UsersAccessHubView(new FakeSource(), 'me')
        const nav = new FakeNav()
        nav.Caps = Caps.With(false)
        hub.AttachNavigator(nav)
        await hub.Refresh()
        hub.Dispose()
    })
})
