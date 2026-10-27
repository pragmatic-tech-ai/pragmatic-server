import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { DataGridRow } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid.js'
import { AdoptWizard } from '../src/adopt-wizard.js'
import { ReleasesView } from '../src/releases-view.js'
import { ScreenState } from '../src/kit/index.js'
import { EnvStatus, EnvType, Template } from '../src/tenant-types.js'
import type { AdminCapabilitiesDto, EnvironmentDto, HiveRolloutDto, IReleasesSource, ITenantNavigator, ManifestDto } from '../src/tenant-types.js'

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

    public static Texts(v: Visual): string[]
    {
        return Fixtures.Collect(v).map(x => (x as unknown as { Text?: unknown }).Text).filter((t): t is string => typeof t === 'string')
    }

    public static Env(name: string): EnvironmentDto
    {
        return { name, template: Template.DevBlank, type: EnvType.Runtime, environmentId: 'id-' + name, hiveId: 'h1', hostPort: 1, status: EnvStatus.Running, createdAt: '', httpUrl: '', wsUrl: '' }
    }
}

class FakeSource implements IReleasesSource
{
    public Manifests: ManifestDto[] = [
        { id: 'v1', image: 'img1', publishedAt: '2026-09-01T00:00:00Z' },
        { id: 'v2', image: 'img2', notes: 'fixes things', publishedAt: '2026-10-01T00:00:00Z' },
    ]
    public Rollout: HiveRolloutDto = {
        targetVersion: 'v1',
        environments: [
            { environmentName: 'alpha', runningImage: 'img1', obsolete: false, ready: true },
            { environmentName: 'beta', runningImage: 'img1', obsolete: false, ready: true },
        ],
    }
    public Error: Error | undefined

    public async ListManifests(): Promise<ManifestDto[]>
    {
        if (this.Error !== undefined)
        {
            throw this.Error
        }
        return this.Manifests
    }
    public async GetRollout(_hiveId: string): Promise<HiveRolloutDto> { return this.Rollout }
    public async ListEnvironments(): Promise<EnvironmentDto[]> { return this.Rollout.environments.map(e => Fixtures.Env(e.environmentName)) }
    public async SelectTarget(_hiveId: string, _version: string): Promise<void> { }
}

class Nav implements ITenantNavigator
{
    public Caps: AdminCapabilitiesDto | undefined

    public ShowLogin(): void {}
    public ShowTree(): void {}
    public ShowHiveDetail(): void {}
    public ShowEnvironmentDetail(_env: EnvironmentDto): void {}
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
    public static async Make(src = new FakeSource(), caps?: AdminCapabilitiesDto): Promise<{ view: ReleasesView; src: FakeSource }>
    {
        Fixtures.InitApp()
        const view = new ReleasesView(src, 'h1')
        const nav = new Nav()
        nav.Caps = caps
        view.AttachNavigator(nav)
        await view.Refresh()
        return { view, src }
    }
}

describe('ReleasesView', () =>
{
    it('renders an offer card per offer with the not-on count', async () =>
    {
        const { view } = await Harness.Make()
        assert.equal(view.Host.State, ScreenState.Populated)
        assert.equal(view.AdoptActions.length, 1)
        const texts = Fixtures.Texts(view)
        assert.ok(texts.includes('v2'))
        assert.ok(texts.includes('fixes things'))
        assert.ok(texts.includes('2' + ReleasesView.NotOnSuffix))
    })

    it('shows the empty state when no versions are offered', async () =>
    {
        const src = new FakeSource()
        src.Manifests = [{ id: 'v1', image: 'img1', publishedAt: '2026-09-01T00:00:00Z' }]
        const { view } = await Harness.Make(src)
        assert.equal(view.Host.State, ScreenState.Empty)
        assert.ok(Fixtures.Texts(view.Host).includes(ReleasesView.EmptyTitle))
    })

    it('renders the matrix with environment rows and Running cells', async () =>
    {
        const { view } = await Harness.Make()
        const grid = view.MatrixGrid
        assert.ok(grid)
        const rows = grid.logicalChildren.filter(c => c instanceof DataGridRow) as DataGridRow[]
        assert.equal(rows.length, 2)
        const texts = Fixtures.Texts(rows[0])
        assert.ok(texts.includes('alpha'))
        assert.ok(texts.includes('Running'))
        assert.ok(texts.includes(ReleasesView.NotRunningText))
    })

    it('opens an AdoptWizard when Adopt is clicked, once only', async () =>
    {
        const { view } = await Harness.Make()
        const act = view.AdoptActions[0]!
        for (let i = 0; i < 2; i++)
        {
            for (const h of (act as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
            {
                h({})
            }
        }
        assert.ok(view.OpenWizard instanceof AdoptWizard)
        assert.equal(Fixtures.Collect(view).filter(v => v instanceof AdoptWizard).length, 1)
    })

    it('disables Adopt naming the permission when adopt is false', async () =>
    {
        const { view } = await Harness.Make(new FakeSource(), { envs: true, adopt: false, access: true, settings: true })
        const act = view.AdoptActions[0]!
        assert.equal(act.Enabled, false)
        assert.ok(act.DisabledHint?.includes(ReleasesView.NeedAdopt))
    })

    it('shows the error state when the load fails', async () =>
    {
        const src = new FakeSource()
        src.Error = new Error('boom')
        const { view } = await Harness.Make(src)
        assert.equal(view.Host.State, ScreenState.Error)
        assert.ok(Fixtures.Texts(view.Host).includes('boom'))
    })
})
