import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import type { AdminSnapshotDto, EnvironmentDto, ITenantNavigator, IUsersAccessSource } from '../src/tenant-types.js'
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
})
