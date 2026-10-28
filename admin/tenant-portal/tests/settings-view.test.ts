import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { SettingsView } from '../src/settings-view.js'
import type { ISettingsSource } from '../src/settings-view-model.js'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { PillKind, ScreenState, StatusPill } from '../src/kit/index.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import type { HiveDto, TenantProfileDto } from '../src/tenant-types.js'

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

    public static Collect(v: Visual, out: Visual[] = []): Visual[]
    {
        out.push(v)
        for (const c of v.visualChildren)
        {
            Fixtures.Collect(c, out)
        }
        return out
    }

    public static Joined(v: Visual): string
    {
        return Fixtures.Collect(v).map(x => (x as unknown as { Text?: unknown }).Text).filter((t): t is string => typeof t === 'string').join('|')
    }
}

class FakeSource implements ISettingsSource
{
    public Prof: TenantProfileDto | undefined = {
        principalId: 'p', roleLabel: 'Tenant Owner', ownerContact: 'owner@acme.test',
        tenant: { id: 'tid-1', displayName: 'Acme Corp', organisation: 'Acme Org' },
        hive: { id: 'h1', displayName: 'Acme Hive' }, capabilities: {} as never,
        idp: { baseUrl: 'https://idp.acme.test', signingCaConfigured: true, adminTokenConfigured: false },
    }
    public Hives: HiveDto[] = [{ id: 'h1', tenantId: 't1', displayName: 'Acme Hive', cluster: { backend: 'kubernetes', mode: 'shared' }, registry: { mode: 'external', endpoint: 'reg.acme.test' }, createdAt: '2026-01-02' }]
    public Failure: unknown

    public async Profile(): Promise<TenantProfileDto>
    {
        if (this.Failure !== undefined)
        {
            throw this.Failure
        }
        return this.Prof as TenantProfileDto
    }

    public async ListHives(): Promise<HiveDto[]>
    {
        return this.Hives
    }
}

class Harness
{
    public static async Make(src = new FakeSource()): Promise<SettingsView>
    {
        Fixtures.InitApp()
        const view = new SettingsView(src)
        await view.Refresh()
        return view
    }
}

describe('SettingsView', () =>
{
    it('shows loading before the first load', () =>
    {
        Fixtures.InitApp()
        assert.equal(new SettingsView(new FakeSource()).StateHost.State, ScreenState.Loading)
    })

    it('has the three tabs', async () =>
    {
        const view = await Harness.Make()
        assert.equal(view.StateHost.State, ScreenState.Populated)
        const labels = Fixtures.Joined(view.Tabs)
        assert.ok(labels.includes(SettingsView.TabHive))
        assert.ok(labels.includes(SettingsView.TabProfile))
        assert.ok(labels.includes(SettingsView.TabIdp))
    })

    it('Hive tab shows real fields only', async () =>
    {
        const t = Fixtures.Joined((await Harness.Make()).HiveTab)
        for (const s of ['Acme Hive', 'kubernetes', 'shared', 'external', 'reg.acme.test', '2026-01-02', SettingsView.HiveNote])
        {
            assert.ok(t.includes(s), s)
        }
        assert.ok(!/base ?domain|region|namespace/i.test(t))
    })

    it('Profile tab shows fields and has no Edit control', async () =>
    {
        const t = Fixtures.Joined((await Harness.Make()).ProfileTab)
        for (const s of ['Acme Corp', 'tid-1', 'Acme Org', 'owner@acme.test', 'Tenant Owner', SettingsView.ProfileNote])
        {
            assert.ok(t.includes(s), s)
        }
        assert.ok(!/edit/i.test(t))
    })

    it('Identity provider shows base url and presence pills with no actions', async () =>
    {
        const view = await Harness.Make()
        const t = Fixtures.Joined(view.IdpTab)
        assert.ok(t.includes('https://idp.acme.test'))
        assert.ok(t.includes(SettingsView.Configured))
        assert.ok(t.includes(SettingsView.NotConfigured))
        assert.ok(t.includes(SettingsView.IdpNote))
        const pills = Fixtures.Collect(view.IdpTab).filter((v): v is StatusPill => v instanceof StatusPill)
        assert.deepEqual(pills.map(p => p.Kind), [PillKind.Active, PillKind.Unknown])
        assert.ok(!/rotate|revoke|edit/i.test(t))
    })

    it('absent idp renders the honest not-configured state', async () =>
    {
        const src = new FakeSource()
        delete (src.Prof as { idp?: unknown }).idp
        const t = Fixtures.Joined((await Harness.Make(src)).IdpTab)
        assert.ok(t.includes(SettingsView.NoIdp))
        assert.ok(!t.includes(SettingsView.KeySigningCa))
    })

    it('Error, NoData and Forbidden hosts render', async () =>
    {
        const e = new FakeSource()
        e.Failure = new Error('boom')
        const ev = await Harness.Make(e)
        assert.equal(ev.StateHost.State, ScreenState.Error)
        assert.ok(Fixtures.Joined(ev.StateHost).includes('boom'))
        const n = new FakeSource()
        n.Prof = undefined
        assert.equal((await Harness.Make(n)).StateHost.State, ScreenState.Empty)
        const f = new FakeSource()
        f.Failure = new TenantApiError(TenantApiError.ForbiddenStatus, 'no')
        assert.equal((await Harness.Make(f)).StateHost.State, ScreenState.Denied)
    })

    it('Dispose stops re-rendering', async () =>
    {
        const src = new FakeSource()
        const view = await Harness.Make(src)
        view.Dispose()
        src.Failure = new Error('later')
        await view.Vm.Load()
        assert.equal(view.StateHost.State, ScreenState.Populated)
    })
})

describe('SettingsView read-only invariant', () =>
{
    it('has zero buttons across the three tab contents', async () =>
    {
        const view = await Harness.Make()
        for (const tab of [view.HiveTab, view.ProfileTab, view.IdpTab])
        {
            assert.equal(Fixtures.Collect(tab).filter(v => v instanceof Button).length, 0)
        }
    })
})
