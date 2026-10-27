import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Checkbox } from '@pragmatic-tech-ai/mural/framework/toggles/checkbox.js'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { DataGridRow } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid.js'
import { EnvironmentsView } from '../src/environments-view.js'
import { EnvironmentsViewModel } from '../src/environments-view-model.js'
import { ScreenState, EmptyStatePanel } from '../src/kit/index.js'
import { EnvStatus, EnvType, Template } from '../src/tenant-types.js'
import type { AdminCapabilitiesDto, CreateEnvironmentParams, EnvironmentDto, HiveHealthDto, IEnvironmentsSource, ITenantNavigator } from '../src/tenant-types.js'

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

    public static Env(name: string, status: EnvStatus): EnvironmentDto
    {
        return { name, template: Template.DevBlank, type: EnvType.Runtime, environmentId: 'id-' + name, hiveId: 'h1', hostPort: 1, status, createdAt: '', httpUrl: 'http://' + name, wsUrl: '' }
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
        if (n.Children !== undefined)
        {
            for (const c of n.Children)
            {
                out.push(...Fixtures.Texts(c))
            }
        }
        return out
    }

    public static VisualTexts(v: Visual): string[]
    {
        return Fixtures.Collect(v).map(x => (x as unknown as { Text?: unknown }).Text).filter((t): t is string => typeof t === 'string')
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

    public static Click(b: Button): void
    {
        for (const h of (b as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
    }

    public static Rows(view: EnvironmentsView): DataGridRow[]
    {
        return view.Grid.logicalChildren.filter(c => c instanceof DataGridRow) as DataGridRow[]
    }

    public static RowOf(view: EnvironmentsView, index: number, kind: new (...a: never[]) => Visual): Visual[]
    {
        return Fixtures.Collect(Fixtures.Rows(view)[index]).filter(v => v instanceof kind)
    }

    public static async Settle(): Promise<void>
    {
        await new Promise(r => setTimeout(r, 0))
    }
}

class FakeSource implements IEnvironmentsSource
{
    public Envs: EnvironmentDto[] = [Fixtures.Env('alpha', EnvStatus.Running), Fixtures.Env('beta', EnvStatus.Stopped)]
    public Calls: string[] = []

    public async ListEnvironments(): Promise<EnvironmentDto[]> { return this.Envs }
    public async GetHealth(_hiveId: string): Promise<HiveHealthDto[]> { return [] }
    public async StartEnvironment(name: string): Promise<EnvironmentDto> { this.Calls.push('start:' + name); return Fixtures.Env(name, EnvStatus.Running) }
    public async StopEnvironment(name: string): Promise<EnvironmentDto> { this.Calls.push('stop:' + name); return Fixtures.Env(name, EnvStatus.Stopped) }
    public async RestartEnvironment(name: string): Promise<EnvironmentDto> { this.Calls.push('restart:' + name); return Fixtures.Env(name, EnvStatus.Running) }
    public async CreateEnvironment(_p: CreateEnvironmentParams): Promise<EnvironmentDto> { throw new Error('unused') }
}

class Nav implements ITenantNavigator
{
    public Opened: EnvironmentDto[] = []
    public Caps: AdminCapabilitiesDto | undefined

    public ShowLogin(): void {}
    public ShowTree(): void {}
    public ShowHiveDetail(): void {}
    public ShowEnvironmentDetail(env: EnvironmentDto): void { this.Opened.push(env) }
    public ShowUsersAccess(): void {}
    public ShowServiceTokens(): void {}
    public ShowRolesPrivileges(): void {}
    public ShowFieldSecurity(): void {}
    public ShowSection(_section: unknown): void {}
    public get Profile(): undefined { return undefined }
    public get Capabilities(): AdminCapabilitiesDto | undefined { return this.Caps }
    public get OwnerContact(): undefined { return undefined }
}

class Harness
{
    public static async Make(src = new FakeSource(), caps?: AdminCapabilitiesDto): Promise<{ view: EnvironmentsView; vm: EnvironmentsViewModel; nav: Nav; src: FakeSource }>
    {
        Fixtures.InitApp()
        const vm = new EnvironmentsViewModel(src)
        const view = new EnvironmentsView(vm)
        const nav = new Nav()
        nav.Caps = caps
        view.AttachNavigator(nav)
        await view.Refresh()
        return { view, vm, nav, src }
    }
}

describe('EnvironmentsView', () =>
{
    it('builds six columns and one row per environment', async () =>
    {
        const { view } = await Harness.Make()
        assert.deepEqual([...view.Grid.Columns].map(c => c.Header), [
            EnvironmentsView.SelectHeader, EnvironmentsView.EnvironmentHeader, EnvironmentsView.StatusHeader,
            EnvironmentsView.ApplicationHeader, EnvironmentsView.HealthHeader, EnvironmentsView.UrlHeader])
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal((view.Grid.ItemsSource as unknown[]).length, 2)
        assert.equal(Fixtures.Rows(view).length, 2)
        assert.ok(Fixtures.VisualTexts(Fixtures.Rows(view)[0]).includes('http://alpha'))
        assert.ok(Fixtures.VisualTexts(Fixtures.Rows(view)[1]).includes(EnvironmentsView.StoppedText))
    })

    it('shows the empty state with a Create action when there are no environments', async () =>
    {
        const src = new FakeSource()
        src.Envs = []
        const { view } = await Harness.Make(src)
        assert.equal(view.Host.State, ScreenState.Empty)
        const all = Fixtures.Collect(view.Host)
        assert.ok(all.some(v => v instanceof EmptyStatePanel))
        assert.ok(Fixtures.Texts(view.Host).includes(EnvironmentsView.EmptyTitle))
        assert.ok(all.some(v => v instanceof Button && Fixtures.Texts(v).includes(EnvironmentsView.CreateLabel)))
    })

    it('gates Create and bulk actions on the envs capability', async () =>
    {
        const caps = (envs: boolean): AdminCapabilitiesDto => ({ envs, adopt: true, access: true, settings: true })
        for (const [c, want] of [[caps(false), false], [caps(true), true], [undefined, true]] as const)
        {
            const { view, vm } = await Harness.Make(new FakeSource(), c)
            assert.equal(view.CreateAction.Enabled, want)
            vm.Toggle('alpha')
            assert.equal(view.BulkActions.length, 3)
            assert.deepEqual(view.BulkActions.map(a => a.Enabled), [want, want, want])
        }
    })

    it('Create invokes the settable handler', async () =>
    {
        const { view } = await Harness.Make()
        let n = 0
        view.CreateHandler = () => { n++ }
        view.CreateAction.Press()
        assert.equal(n, 1)
    })

    it('opening a row navigates to its Dto', async () =>
    {
        const { view, nav, vm } = await Harness.Make()
        const open = Fixtures.RowOf(view, 1, Button).find(b => Fixtures.Texts(b).includes('beta')) as Button
        Fixtures.Click(open)
        assert.equal(nav.Opened.length, 1)
        assert.equal(nav.Opened[0], vm.Rows[1].Dto)
    })

    it('the search box filters rows through the view model without echo', async () =>
    {
        const { view, vm } = await Harness.Make()
        view.SearchBox.Text = 'alp'
        assert.equal(vm.Filter, 'alp')
        assert.deepEqual(vm.Rows.map(r => r.Name), ['alpha'])
        assert.equal(Fixtures.Rows(view).length, 1)
        vm.Filter = ''
        assert.equal(view.SearchBox.Text, '')
        assert.equal(Fixtures.Rows(view).length, 2)
    })

    it('shows the bulk toolbar only while a selection exists and a row checkbox toggles it', async () =>
    {
        const { view, vm } = await Harness.Make()
        assert.equal(view.BulkActions.length, 0)
        const box = Fixtures.RowOf(view, 0, Checkbox)[0] as Checkbox
        Fixtures.Click(box)
        assert.ok(vm.Selected.has('alpha'))
        assert.equal(view.BulkActions.length, 3)
        assert.equal((Fixtures.RowOf(view, 0, Checkbox)[0] as Checkbox).IsChecked, true)
        vm.ClearSelection()
        assert.equal(view.BulkActions.length, 0)
    })

    it('the header checkbox selects all filtered rows, then clears', async () =>
    {
        const { view, vm } = await Harness.Make()
        vm.Filter = 'alp'
        Fixtures.Click(view.HeaderCheckbox)
        assert.deepEqual([...vm.Selected], ['alpha'])
        assert.equal(view.HeaderCheckbox.IsChecked, true)
        Fixtures.Click(view.HeaderCheckbox)
        assert.equal(vm.Selected.size, 0)
        assert.equal(view.HeaderCheckbox.IsChecked, false)
    })

    it('a bulk action runs against the source and clears the selection', async () =>
    {
        const { view, vm, src } = await Harness.Make()
        vm.Toggle('beta')
        Fixtures.Click(view.BulkActions[0])
        await Fixtures.Settle()
        assert.deepEqual(src.Calls, ['start:beta'])
        assert.equal(vm.Selected.size, 0)
    })
})
