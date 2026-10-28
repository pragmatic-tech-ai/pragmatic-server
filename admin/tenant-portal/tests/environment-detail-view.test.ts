import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { EnvironmentDetailView } from '../src/environment-detail-view.js'
import type { IEnvDetailSource } from '../src/environment-detail-view-model.js'
import { ActivityLog } from '../src/activity-log.js'
import { ActivityList, Banner, BannerTone, ConfirmDialog, Section, StatusPill, Tabs } from '../src/kit/index.js'
import { EnvStatus, EnvType, Template, TenantEventType } from '../src/tenant-types.js'
import type { ITenantNavigator } from '../src/tenant-types.js'
import type { EnvironmentDto, HiveHealthDto } from '../src/tenant-types.js'

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

    public static Env(status: EnvStatus): EnvironmentDto
    {
        return { name: 'alpha', template: Template.DevBlank, type: EnvType.Runtime, environmentId: 'id-alpha', hiveId: 'h1', hostPort: 1, status, createdAt: '2026-01-02', httpUrl: 'http://alpha.example', wsUrl: '' }
    }

    public static Make(status: EnvStatus, source: FakeSource = new FakeSource(), extra: Partial<EnvironmentDto> = {}): { view: EnvironmentDetailView; src: FakeSource }
    {
        Fixtures.InitApp()
        return { view: new EnvironmentDetailView(source, { ...Fixtures.Env(status), ...extra }, 'h1'), src: source }
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

    public static Texts(v: Visual): string[]
    {
        return Fixtures.Collect(v).map(x => (x as unknown as { Text?: unknown }).Text).filter((t): t is string => typeof t === 'string')
    }

    public static ButtonLabelled(v: Visual, label: string): Button | undefined
    {
        return Fixtures.Collect(v).find(x => x instanceof Button && (x.Content as unknown as { Text?: string })?.Text === label) as Button | undefined
    }

    public static Click(v: Visual, label: string): void
    {
        const b = Fixtures.ButtonLabelled(v, label)
        assert.ok(b, 'button not found: ' + label)
        for (const h of (b as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
    }

    public static TabsOf(view: EnvironmentDetailView): Tabs
    {
        return [...view.Children].find(c => c instanceof Tabs) as Tabs
    }

    public static DialogOf(view: EnvironmentDetailView): ConfirmDialog | undefined
    {
        return [...view.Children].find(c => c instanceof ConfirmDialog) as ConfirmDialog | undefined
    }

    public static async Settle(): Promise<void>
    {
        await new Promise(r => setTimeout(r, 0))
    }
}

class FakeNavigator
{
    public readonly Activity = new ActivityLog()
    public DrawerOpened = 0

    public OpenActivityDrawer(): void
    {
        this.DrawerOpened++
    }
}

class FakeSource implements IEnvDetailSource
{
    public Calls: string[] = []
    public Opened = 0
    public Closed = 0
    public DeleteError: Error | undefined
    public Emit: (t: string) => void = () => undefined

    public async StartEnvironment(name: string): Promise<EnvironmentDto> { this.Calls.push('start:' + name); return Fixtures.Env(EnvStatus.Running) }
    public async StopEnvironment(name: string): Promise<EnvironmentDto> { this.Calls.push('stop:' + name); return Fixtures.Env(EnvStatus.Stopped) }
    public async RestartEnvironment(name: string): Promise<EnvironmentDto> { this.Calls.push('restart:' + name); return Fixtures.Env(EnvStatus.Running) }
    public async DeleteEnvironment(name: string): Promise<void>
    {
        this.Calls.push('delete:' + name)
        if (this.DeleteError !== undefined)
        {
            throw this.DeleteError
        }
    }
    public async GetHealth(_hiveId: string): Promise<HiveHealthDto[]> { return [{ environmentName: 'alpha', ready: true, runningImage: 'img:v7', detail: 'ok' }] }
    public OpenLogStream(_name: string, onChunk: (t: string) => void): () => void
    {
        this.Opened++
        this.Emit = onChunk
        return () => { this.Closed++ }
    }
}

describe('EnvironmentDetailView', () =>
{
    it('header shows name, two pills and the live URL when Running', () =>
    {
        const { view } = Fixtures.Make(EnvStatus.Running)
        assert.equal(Fixtures.Collect(view).filter(x => x instanceof StatusPill).length, 2)
        const texts = Fixtures.Texts(view)
        assert.ok(texts.includes('alpha'))
        assert.ok(texts.includes('URL: http://alpha.example'))
    })

    it('shows the empty-state text when not serving', () =>
    {
        const { view } = Fixtures.Make(EnvStatus.Stopped)
        assert.ok(Fixtures.Texts(view).includes('URL: ' + EnvironmentDetailView.NotServingText))
    })

    it('has three tabs with exact labels and per-tab content', async () =>
    {
        const { view } = Fixtures.Make(EnvStatus.Running)
        await view.Refresh()
        const labels = [EnvironmentDetailView.AppTabLabel, EnvironmentDetailView.HealthTabLabel, EnvironmentDetailView.AccessTabLabel]
        assert.deepEqual(labels, ['Application & version', 'Health & activity', 'Access'])
        for (const l of labels)
        {
            assert.ok(Fixtures.ButtonLabelled(Fixtures.TabsOf(view), l), l)
        }
        let t = Fixtures.Texts(Fixtures.TabsOf(view).ContentHost)
        for (const s of ['Version', 'v7', 'Type', 'Template', 'Environment id', 'id-alpha', 'Created', '2026-01-02'])
        {
            assert.ok(t.includes(s), s)
        }
        Fixtures.Click(Fixtures.TabsOf(view), 'Health & activity')
        t = Fixtures.Texts(Fixtures.TabsOf(view).ContentHost)
        assert.ok(t.includes('Health: ready - ok'))
        assert.ok(t.includes('View logs'))
        assert.ok(!t.includes('Logs'))
        Fixtures.Click(Fixtures.TabsOf(view), 'View logs')
        assert.equal(Fixtures.TabsOf(view).ActiveIndex, 1)
        t = Fixtures.Texts(Fixtures.TabsOf(view).ContentHost)
        assert.ok(t.includes('Hide logs'))
        assert.ok(t.includes('Logs'))
        Fixtures.Click(Fixtures.TabsOf(view), 'Access')
        t = Fixtures.Texts(Fixtures.TabsOf(view).ContentHost)
        assert.ok(t.includes('Address'))
        assert.ok(t.includes('http://alpha.example'))
    })

    it('Application and Access tabs show the deployed UI bundle, signature and sign-in address', () =>
    {
        const { view } = Fixtures.Make(EnvStatus.Running, new FakeSource(), { uiBundle: { appName: 'northwind', appVersion: '1.0.0' }, idpBaseDomain: 'apps.example.com' })
        let t = Fixtures.Texts(Fixtures.TabsOf(view).ContentHost)
        assert.ok(t.includes('UI bundle'))
        assert.ok(t.includes('northwind 1.0.0'))
        assert.ok(t.includes('Image signature'))
        assert.ok(t.some(x => x.startsWith('Signed')))
        Fixtures.Click(Fixtures.TabsOf(view), 'Access')
        t = Fixtures.Texts(Fixtures.TabsOf(view).ContentHost)
        assert.ok(t.includes('Sign-in address'))
        assert.ok(t.some(x => x.includes('apps.example.com') && x.includes('id-alpha')))
    })

    it('shows honest absent states without a bundle or federation', () =>
    {
        const { view } = Fixtures.Make(EnvStatus.Running)
        let t = Fixtures.Texts(Fixtures.TabsOf(view).ContentHost)
        assert.ok(t.includes('No UI bundle deployed yet'))
        assert.ok(t.includes('Not applicable'))
        assert.ok(!t.some(x => x.startsWith('Signed')))
        Fixtures.Click(Fixtures.TabsOf(view), 'Access')
        t = Fixtures.Texts(Fixtures.TabsOf(view).ContentHost)
        assert.ok(t.includes('Not federated'))
    })

    it('Application and Access tabs carry no action controls', () =>
    {
        const { view } = Fixtures.Make(EnvStatus.Running, new FakeSource(), { uiBundle: { appName: 'n', appVersion: '1' }, idpBaseDomain: 'a.b' })
        assert.equal(Fixtures.Collect(Fixtures.TabsOf(view).ContentHost).filter(x => x instanceof Button).length, 0)
        Fixtures.Click(Fixtures.TabsOf(view), 'Access')
        assert.equal(Fixtures.Collect(Fixtures.TabsOf(view).ContentHost).filter(x => x instanceof Button).length, 0)
    })

    it('Delete opens a ConfirmDialog; confirm is gated by the typed name and deletes once', async () =>
    {
        const { view, src } = Fixtures.Make(EnvStatus.Running)
        Fixtures.Click(view, 'Delete')
        const dialog = Fixtures.DialogOf(view)
        assert.ok(dialog)
        assert.ok(dialog.Lines.includes('- This cannot be undone.'))
        assert.equal(dialog.ConfirmEnabled, false)
        dialog.SetTyped('alph')
        assert.equal(dialog.ConfirmEnabled, false)
        dialog.Confirm()
        assert.deepEqual(src.Calls, [])
        dialog.SetTyped('alpha')
        assert.equal(dialog.ConfirmEnabled, true)
        dialog.Confirm()
        await Fixtures.Settle()
        assert.deepEqual(src.Calls, ['delete:alpha'])
        assert.equal(Fixtures.DialogOf(view), undefined)
    })

    it('Cancel removes the dialog without deleting', async () =>
    {
        const { view, src } = Fixtures.Make(EnvStatus.Running)
        Fixtures.Click(view, 'Delete')
        Fixtures.DialogOf(view)?.Cancel()
        await Fixtures.Settle()
        assert.deepEqual(src.Calls, [])
        assert.equal(Fixtures.DialogOf(view), undefined)
    })

    it('a failed delete surfaces an error', async () =>
    {
        const src = new FakeSource()
        src.DeleteError = new Error('boom')
        const { view } = Fixtures.Make(EnvStatus.Running, src)
        Fixtures.Click(view, 'Delete')
        const dialog = Fixtures.DialogOf(view)
        assert.ok(dialog)
        dialog.SetTyped('alpha')
        dialog.Confirm()
        await Fixtures.Settle()
        assert.ok(Fixtures.Texts(view).includes('error: boom'))
    })

    it('Failed renders a Danger banner and keeps the tabs', () =>
    {
        const { view } = Fixtures.Make(EnvStatus.Failed)
        const banner = [...view.Children].find(c => c instanceof Banner) as Banner
        assert.equal(banner.Tone, BannerTone.Danger)
        assert.equal(banner.Text, EnvironmentDetailView.FailedBannerText)
        assert.ok(Fixtures.TabsOf(view))
    })

    it('Unknown renders the info note; Running renders no banner', () =>
    {
        const unknown = Fixtures.Make(EnvStatus.Unknown).view
        assert.equal(([...unknown.Children].find(c => c instanceof Banner) as Banner).Tone, BannerTone.Info)
        const running = Fixtures.Make(EnvStatus.Running).view
        assert.ok(![...running.Children].some(c => c instanceof Banner))
    })

    it('log tailing survives a re-render', async () =>
    {
        const { view, src } = Fixtures.Make(EnvStatus.Running)
        await view.Refresh()
        Fixtures.Click(Fixtures.TabsOf(view), 'Health & activity')
        Fixtures.Click(Fixtures.TabsOf(view), 'View logs')
        Fixtures.Click(Fixtures.TabsOf(view), 'Pause')
        Fixtures.Click(Fixtures.TabsOf(view), 'Resume')
        src.Emit('some-line')
        assert.ok(Fixtures.Texts(view).includes('some-line'))
    })

    it('Dispose closes the log stream once; tab switches do not reopen it', async () =>
    {
        const { view, src } = Fixtures.Make(EnvStatus.Running)
        await view.Refresh()
        assert.equal(src.Opened, 1)
        Fixtures.Click(Fixtures.TabsOf(view), 'Health & activity')
        Fixtures.Click(Fixtures.TabsOf(view), 'View logs')
        Fixtures.Click(Fixtures.TabsOf(view), 'Access')
        assert.equal(src.Opened, 1)
        assert.equal(src.Closed, 0)
        view.Dispose()
        view.Dispose()
        assert.equal(src.Closed, 1)
    })

    it('Health tab lists only this environment activity, with no history strip', () =>
    {
        const { view } = Fixtures.Make(EnvStatus.Running)
        const nav = new FakeNavigator()
        nav.Activity.Record({ type: TenantEventType.EnvironmentChanged, environmentName: 'alpha' })
        nav.Activity.Record({ type: TenantEventType.EnvironmentChanged, environmentName: 'beta' })
        nav.Activity.Record({ type: TenantEventType.HealthChanged, environmentName: 'alpha' })
        view.AttachNavigator(nav as unknown as ITenantNavigator)
        view.Render()
        Fixtures.Click(Fixtures.TabsOf(view), 'Health & activity')
        const host = Fixtures.TabsOf(view).ContentHost
        const list = Fixtures.Collect(host).find(x => x instanceof ActivityList) as ActivityList
        assert.equal(list.Rows.length, 2)
        assert.equal(list.IsEmpty, false)
        const panel = host.visualChildren[0]
        assert.deepEqual([...panel.visualChildren].map(c => c.constructor.name), ['TextBlock', 'Section', 'Button'])
        assert.equal(Fixtures.Collect(host).filter(x => x instanceof Section).length, 1)
    })

    it('Health tab shows the honest empty text when nothing was observed for this environment', () =>
    {
        const { view } = Fixtures.Make(EnvStatus.Running)
        const nav = new FakeNavigator()
        nav.Activity.Record({ type: TenantEventType.EnvironmentChanged, environmentName: 'beta' })
        view.AttachNavigator(nav as unknown as ITenantNavigator)
        view.Render()
        Fixtures.Click(Fixtures.TabsOf(view), 'Health & activity')
        const host = Fixtures.TabsOf(view).ContentHost
        const list = Fixtures.Collect(host).find(x => x instanceof ActivityList) as ActivityList
        assert.equal(list.IsEmpty, true)
        assert.ok(Fixtures.Texts(host).includes(EnvironmentDetailView.ActivityEmptyText))
        assert.ok(Fixtures.Texts(host).includes(EnvironmentDetailView.ActivityTitle))
    })
})
