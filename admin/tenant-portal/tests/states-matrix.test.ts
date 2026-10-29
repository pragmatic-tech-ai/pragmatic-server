import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { ActivityLog } from '../src/activity-log.js'
import { ComingSoonView } from '../src/coming-soon-view.js'
import { ConnectionStatusView } from '../src/connection-status-view.js'
import { EnvironmentsView } from '../src/environments-view.js'
import { EnvironmentsViewModel } from '../src/environments-view-model.js'
import { ScreenState } from '../src/kit/index.js'
import { OverviewView } from '../src/overview-view.js'
import { ReleasesView } from '../src/releases-view.js'
import { SecurityModelView } from '../src/security-model-view.js'
import { SettingsView } from '../src/settings-view.js'
import type { ISettingsSource } from '../src/settings-view-model.js'
import type { ISecurityModelEnvSource } from '../src/security-model-view-model.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import { EnvStatus, EnvType, Template } from '../src/tenant-types.js'
import type { AdminCapabilitiesDto, AdoptionLedgerDto, CreateEnvironmentParams, EnvironmentDto, HiveDto, HiveHealthDto, HiveRolloutDto, IConnectionSource, IEnvironmentsSource, IOverviewSource, IReleasesSource, ITenantNavigator, ManifestDto, SecurityModelDto, TenantProfileDto } from '../src/tenant-types.js'

// Drives every ScreenHost-backed full-page view through each ScreenState it genuinely reaches.
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

    public static Env(name: string): EnvironmentDto
    {
        return { name, template: Template.DevBlank, type: EnvType.Runtime, environmentId: 'id-' + name, hiveId: 'h1', hostPort: 1, status: EnvStatus.Running, createdAt: '', httpUrl: 'http://' + name, wsUrl: '' }
    }

    public static Hive(): HiveDto
    {
        return { id: 'h1', tenantId: 't1', displayName: 'Hive', cluster: { backend: 'k', mode: 'm' }, registry: { mode: 'r' }, createdAt: '' }
    }

    public static Forbidden(): TenantApiError
    {
        return new TenantApiError(TenantApiError.ForbiddenStatus, 'no')
    }
}

class Nav implements ITenantNavigator
{
    public readonly Log = new ActivityLog()

    public ShowLogin(): void {}
    public ShowTree(): void {}
    public ShowHiveDetail(): void {}
    public ShowEnvironmentDetail(_env: EnvironmentDto): void {}
    public ShowUsersAccess(): void {}
    public ShowServiceTokens(): void {}
    public ShowSection(_section: unknown): void {}
    public get Profile(): undefined { return undefined }
    public get Capabilities(): AdminCapabilitiesDto | undefined { return undefined }
    public get OwnerContact(): undefined { return undefined }
    public get Activity(): ActivityLog { return this.Log }
    public OpenActivityDrawer(): void {}
}

class OverviewSource implements IOverviewSource, IEnvironmentsSource, IConnectionSource
{
    public Envs: EnvironmentDto[] = [Fixtures.Env('alpha')]
    public EnvFailure: Error | undefined

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        if (this.EnvFailure !== undefined)
        {
            throw this.EnvFailure
        }
        return this.Envs
    }
    public async GetHealth(_hiveId: string): Promise<HiveHealthDto[]> { return [] }
    public async ListManifests(): Promise<ManifestDto[]> { return [{ id: 'v1', image: 'img:v1', publishedAt: '2026-01-01' }] }
    public async ListHives(): Promise<HiveDto[]> { return [Fixtures.Hive()] }
    public async GetRollout(_hiveId: string): Promise<HiveRolloutDto> { return { targetVersion: 'v1', environments: [{ environmentName: 'alpha', runningImage: 'img:v1', obsolete: false, ready: true }] } }
    public async StartEnvironment(name: string): Promise<EnvironmentDto> { return Fixtures.Env(name) }
    public async StopEnvironment(name: string): Promise<EnvironmentDto> { return Fixtures.Env(name) }
    public async RestartEnvironment(name: string): Promise<EnvironmentDto> { return Fixtures.Env(name) }
    public async CreateEnvironment(p: CreateEnvironmentParams): Promise<EnvironmentDto> { return Fixtures.Env(p.name) }
}

class EnvironmentsSource implements IEnvironmentsSource
{
    public Envs: EnvironmentDto[] = [Fixtures.Env('alpha')]
    public ListError: Error | undefined
    public Gate: Array<(envs: EnvironmentDto[]) => void> | undefined

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        if (this.Gate !== undefined)
        {
            const gate = this.Gate
            return new Promise<EnvironmentDto[]>(resolve => { gate.push(resolve) })
        }
        if (this.ListError !== undefined)
        {
            throw this.ListError
        }
        return this.Envs
    }
    public async GetHealth(_hiveId: string): Promise<HiveHealthDto[]> { return [] }
    public async StartEnvironment(name: string): Promise<EnvironmentDto> { return Fixtures.Env(name) }
    public async StopEnvironment(name: string): Promise<EnvironmentDto> { return Fixtures.Env(name) }
    public async RestartEnvironment(name: string): Promise<EnvironmentDto> { return Fixtures.Env(name) }
    public async CreateEnvironment(_p: CreateEnvironmentParams): Promise<EnvironmentDto> { throw new Error('unused') }
}

class ReleasesSource implements IReleasesSource
{
    public Manifests: ManifestDto[] = [
        { id: 'v1', image: 'img1', publishedAt: '2026-09-01T00:00:00Z' },
        { id: 'v2', image: 'img2', publishedAt: '2026-10-01T00:00:00Z' },
    ]
    public Error: Error | undefined
    public Rollout: HiveRolloutDto = {
        targetVersion: 'v1',
        environments: [{ environmentName: 'alpha', runningImage: 'img1', obsolete: false, ready: true }],
    }

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
    public async ListLedger(_hiveId: string): Promise<readonly AdoptionLedgerDto[]> { return [] }
}

class ConnectionSource implements IConnectionSource
{
    public Hives: HiveDto[] = [Fixtures.Hive()]
    public Failure: unknown

    public async ListHives(): Promise<HiveDto[]> { return this.Hives }
    public async GetRollout(_hiveId: string): Promise<HiveRolloutDto>
    {
        if (this.Failure !== undefined)
        {
            throw this.Failure
        }
        return { targetVersion: '1.2.3', environments: [{ environmentName: 'dev', runningImage: 'img:dev-7', obsolete: false, ready: true }] }
    }
}

class SettingsSource implements ISettingsSource
{
    public Prof: TenantProfileDto | undefined = {
        principalId: 'p', roleLabel: 'Tenant Owner', ownerContact: 'owner@acme.test',
        tenant: { id: 'tid-1', displayName: 'Acme Corp', organisation: 'Acme Org' },
        hive: { id: 'h1', displayName: 'Acme Hive' }, capabilities: {} as never,
        idp: { baseUrl: 'https://idp.acme.test', signingCaConfigured: true, adminTokenConfigured: false },
    }
    public Failure: unknown

    public async Profile(): Promise<TenantProfileDto>
    {
        if (this.Failure !== undefined)
        {
            throw this.Failure
        }
        return this.Prof as TenantProfileDto
    }
    public async ListHives(): Promise<HiveDto[]> { return [Fixtures.Hive()] }
}

class SecuritySource implements ISecurityModelEnvSource
{
    public Envs: EnvironmentDto[] = [{ name: 'dev' } as EnvironmentDto]
    public GetError: Error | undefined
    public Model: SecurityModelDto | null = {
        businessUnits: [],
        teams: [],
        membership: { claimsMapping: [], overrides: [] },
        ownershipRules: [],
        roles: [{ id: 'r1', name: 'Viewer', privileges: [] }],
    }

    public async ListEnvironments(): Promise<EnvironmentDto[]> { return this.Envs }
    public async GetSecurityModel(_env: string): Promise<SecurityModelDto | null>
    {
        if (this.GetError !== undefined)
        {
            throw this.GetError
        }
        return structuredClone(this.Model)
    }
    public async SetSecurityModel(_env: string, _model: SecurityModelDto): Promise<void> { }
}

describe('states matrix', () =>
{
    describe('OverviewView.Host', () =>
    {
        it('Loading before the first load, then Populated', async () =>
        {
            Fixtures.InitApp()
            const view = new OverviewView(new OverviewSource(), 'h1')
            view.AttachNavigator(new Nav())
            assert.equal(view.Host.State, ScreenState.Loading)
            await view.Refresh()
            assert.equal(view.Host.State, ScreenState.Populated)
        })

        it('Empty when there are no environments', async () =>
        {
            Fixtures.InitApp()
            const src = new OverviewSource()
            src.Envs = []
            const view = new OverviewView(src, 'h1')
            view.AttachNavigator(new Nav())
            await view.Refresh()
            assert.equal(view.Host.State, ScreenState.Empty)
        })

        it('Error when the environments fail to load (no Denied path: allowed is always true)', async () =>
        {
            Fixtures.InitApp()
            const src = new OverviewSource()
            src.EnvFailure = new Error('boom')
            const view = new OverviewView(src, 'h1')
            view.AttachNavigator(new Nav())
            await view.Refresh()
            assert.equal(view.Host.State, ScreenState.Error)
        })
    })

    describe('EnvironmentsView.Host', () =>
    {
        it('Loading while the first load is in flight, then Populated', async () =>
        {
            Fixtures.InitApp()
            const src = new EnvironmentsSource()
            const gate: Array<(envs: EnvironmentDto[]) => void> = []
            src.Gate = gate
            const view = new EnvironmentsView(new EnvironmentsViewModel(src))
            view.AttachNavigator(new Nav())
            const pending = view.Refresh()
            assert.equal(view.Host.State, ScreenState.Loading)
            gate[0]!(src.Envs)
            await pending
            assert.equal(view.Host.State, ScreenState.Populated)
        })

        it('Empty when the source returns no environments', async () =>
        {
            Fixtures.InitApp()
            const src = new EnvironmentsSource()
            src.Envs = []
            const view = new EnvironmentsView(new EnvironmentsViewModel(src))
            view.AttachNavigator(new Nav())
            await view.Refresh()
            assert.equal(view.Host.State, ScreenState.Empty)
        })

        it('Error when the load fails (no Denied path: allowed is always true)', async () =>
        {
            Fixtures.InitApp()
            const src = new EnvironmentsSource()
            src.ListError = new Error('boom')
            const view = new EnvironmentsView(new EnvironmentsViewModel(src))
            view.AttachNavigator(new Nav())
            await view.Refresh()
            assert.equal(view.Host.State, ScreenState.Error)
        })
    })

    describe('ReleasesView.Host', () =>
    {
        it('Loading before the first load, then Populated', async () =>
        {
            Fixtures.InitApp()
            const view = new ReleasesView(new ReleasesSource(), 'h1')
            view.AttachNavigator(new Nav())
            assert.equal(view.Host.State, ScreenState.Loading)
            await view.Refresh()
            assert.equal(view.Host.State, ScreenState.Populated)
        })

        it('Empty when no newer versions are offered', async () =>
        {
            Fixtures.InitApp()
            const src = new ReleasesSource()
            src.Manifests = [src.Manifests[0]!]
            const view = new ReleasesView(src, 'h1')
            view.AttachNavigator(new Nav())
            await view.Refresh()
            assert.equal(view.Host.State, ScreenState.Empty)
        })

        it('Error when the load fails (no Denied path: allowed is always true)', async () =>
        {
            Fixtures.InitApp()
            const src = new ReleasesSource()
            src.Error = new Error('boom')
            const view = new ReleasesView(src, 'h1')
            view.AttachNavigator(new Nav())
            await view.Refresh()
            assert.equal(view.Host.State, ScreenState.Error)
        })
    })

    describe('ConnectionStatusView.StateHost', () =>
    {
        it('Loading before the first load, then Populated', async () =>
        {
            Fixtures.InitApp()
            const view = new ConnectionStatusView(new ConnectionSource())
            assert.equal(view.StateHost.State, ScreenState.Loading)
            await view.Refresh()
            assert.equal(view.StateHost.State, ScreenState.Populated)
        })

        it('Empty when the tenant has no hive', async () =>
        {
            Fixtures.InitApp()
            const src = new ConnectionSource()
            src.Hives = []
            const view = new ConnectionStatusView(src)
            await view.Refresh()
            assert.equal(view.StateHost.State, ScreenState.Empty)
        })

        it('Error on a generic failure', async () =>
        {
            Fixtures.InitApp()
            const src = new ConnectionSource()
            src.Failure = new Error('boom')
            const view = new ConnectionStatusView(src)
            await view.Refresh()
            assert.equal(view.StateHost.State, ScreenState.Error)
        })

        it('Denied on a 403', async () =>
        {
            Fixtures.InitApp()
            const src = new ConnectionSource()
            src.Failure = Fixtures.Forbidden()
            const view = new ConnectionStatusView(src)
            await view.Refresh()
            assert.equal(view.StateHost.State, ScreenState.Denied)
        })
    })

    describe('SettingsView.StateHost', () =>
    {
        it('Loading before the first load, then Populated', async () =>
        {
            Fixtures.InitApp()
            const view = new SettingsView(new SettingsSource())
            assert.equal(view.StateHost.State, ScreenState.Loading)
            await view.Refresh()
            assert.equal(view.StateHost.State, ScreenState.Populated)
        })

        it('Empty when the profile has no data', async () =>
        {
            Fixtures.InitApp()
            const src = new SettingsSource()
            src.Prof = undefined
            const view = new SettingsView(src)
            await view.Refresh()
            assert.equal(view.StateHost.State, ScreenState.Empty)
        })

        it('Error on a generic failure', async () =>
        {
            Fixtures.InitApp()
            const src = new SettingsSource()
            src.Failure = new Error('boom')
            const view = new SettingsView(src)
            await view.Refresh()
            assert.equal(view.StateHost.State, ScreenState.Error)
        })

        it('Denied on a 403', async () =>
        {
            Fixtures.InitApp()
            const src = new SettingsSource()
            src.Failure = Fixtures.Forbidden()
            const view = new SettingsView(src)
            await view.Refresh()
            assert.equal(view.StateHost.State, ScreenState.Denied)
        })
    })

    describe('SecurityModelView.StateHost', () =>
    {
        it('Loading before the first load, then Populated', async () =>
        {
            Fixtures.InitApp()
            const view = new SecurityModelView(new SecuritySource())
            view.AttachNavigator(new Nav())
            assert.equal(view.StateHost.State, ScreenState.Loading)
            await view.Refresh()
            assert.equal(view.StateHost.State, ScreenState.Populated)
        })

        it('Empty when the model has no roles or profiles', async () =>
        {
            Fixtures.InitApp()
            const src = new SecuritySource()
            src.Model = { ...src.Model!, roles: [], fieldSecurity: undefined }
            const view = new SecurityModelView(src)
            view.AttachNavigator(new Nav())
            await view.Refresh()
            assert.equal(view.StateHost.State, ScreenState.Empty)
        })

        it('Error on a generic failure', async () =>
        {
            Fixtures.InitApp()
            const src = new SecuritySource()
            src.GetError = new Error('boom')
            const view = new SecurityModelView(src)
            view.AttachNavigator(new Nav())
            await view.Refresh()
            assert.equal(view.StateHost.State, ScreenState.Error)
        })

        it('Denied on a 403', async () =>
        {
            Fixtures.InitApp()
            const src = new SecuritySource()
            src.GetError = Fixtures.Forbidden()
            const view = new SecurityModelView(src)
            view.AttachNavigator(new Nav())
            await view.Refresh()
            assert.equal(view.StateHost.State, ScreenState.Denied)
        })
    })

    describe('ComingSoonView.Host', () =>
    {
        it('is statically Empty (a placeholder with no source, so no other state is reachable)', () =>
        {
            Fixtures.InitApp()
            assert.equal(new ComingSoonView('Later').Host.State, ScreenState.Empty)
        })
    })
})
