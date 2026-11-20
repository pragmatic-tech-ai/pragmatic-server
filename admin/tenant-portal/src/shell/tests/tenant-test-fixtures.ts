import { ServiceProvider, type ServiceToken } from '@pragmatic-tech-ai/mural/runtime'
import { Capability } from '@pragmatic-tech-ai/mural/framework/shell/module.js'
import { ClipboardService } from '@pragmatic-tech-ai/mural/framework/shell/services/clipboard-service.js'
import { ContentHostService } from '@pragmatic-tech-ai/mural/framework/shell/services/content-host-service.js'
import { DialogService, type DialogOptions } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import { ApiError, type TenantApiClient } from '../../tenant-api-client.js'
import { ConfigurationApplyOutcome, EnvStatus, EnvType, Template } from '../../tenant-types.js'
import type { ConfigurationApplyDto, ConfigurationComponentDetailDto, ConfigurationComponentDto, ConfigurationDiffDto, ConfigurationOptionDto, ConfigurationTargetDto, ConfigurationVersionDto, ConfigurationVersionSummaryDto } from '../../tenant-types.js'
import type { AdminCapabilitiesDto, AdminSnapshotDto, AdoptionLedgerDto, CreateAccountParams, CreateEnvironmentParams, CreateGraphParams, EmailDomainsDto, EnvironmentDto, GrantMutationDto, GraphDto, HiveDto, HiveHealthDto, HiveRolloutDto, IssueTokenParams, ManifestDto, SecurityCatalogDto, SecurityChangesDto, SecurityModelDto, ServiceTokenSummaryDto, TeamMemberDto, TenantEvent, TenantProfileDto, TokenIssuedDto } from '../../tenant-types.js'
import { AppSession, type IPageReloader } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import { TenantSessionService } from '../tenant-session-service.js'
import { TenantShell } from '../tenant-shell.js'

// Counts reloads instead of touching window.location.
export class FakeReloader implements IPageReloader
{
    public Count = 0

    public Reload(): void
    {
        this.Count++
    }
}

// Lets pending promise continuations run.
export class Tick
{
    public static Next(): Promise<void>
    {
        return new Promise(resolve => setImmediate(resolve))
    }

    // Lets a chain of awaits (load, dialog, submit, refresh) run out.
    public static async Settle(): Promise<void>
    {
        for (let i = 0; i < 10; i++)
        {
            await Tick.Next()
        }
    }
}

// Reads every property a view-model exposes (own fields and prototype-chain
// getters), for assertions about what a view-model can reveal or do.
export class Inspect
{
    public static PropertyValues(target: object): unknown[]
    {
        const values: unknown[] = Object.values(target)
        let proto: object | null = Object.getPrototypeOf(target)
        while (proto !== null && proto !== Object.prototype)
        {
            for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto)))
            {
                if (descriptor.get !== undefined)
                {
                    values.push((target as Record<string, unknown>)[name])
                }
            }
            proto = Object.getPrototypeOf(proto)
        }
        return values
    }

    // Every string reachable from a view-model, recursively; objects in
    // `skip` (e.g. the fake API holding fixture values) are not visited.
    public static ReachableStrings(target: object, skip: object[] = []): string[]
    {
        const found: string[] = []
        const seen = new Set<object>(skip)
        const visit = (value: unknown): void =>
        {
            if (typeof value === 'string')
            {
                found.push(value)
                return
            }
            if (typeof value !== 'object' || value === null || seen.has(value))
            {
                return
            }
            seen.add(value)
            const values = Array.isArray(value) ? value : Inspect.PropertyValues(value)
            for (const inner of values)
            {
                visit(inner)
            }
        }
        visit(target)
        return found
    }
}

// A DialogService stand-in modelled on the real one: records each Show, one
// dialog open at a time (a new Show supersedes the open one, resolving it
// undefined), Close resolves whichever dialog is open now, and Dismiss is the
// Escape / title-bar X path.
export class FakeDialogService extends DialogService
{
    public readonly Shown: DialogOptions[] = []
    private resolve: ((value: unknown) => void) | undefined

    public override Show<T = unknown>(options: DialogOptions): Promise<T | undefined>
    {
        this.Close(undefined)
        this.Shown.push(options)
        return new Promise<T | undefined>(resolve => { this.resolve = resolve as (value: unknown) => void })
    }

    public Dismiss(): void
    {
        this.Close(undefined)
    }

    public override Close(result?: unknown): void
    {
        const resolve = this.resolve
        this.resolve = undefined
        resolve?.(result)
    }

    public override get IsOpen(): boolean
    {
        return this.resolve !== undefined
    }

    // The content view-model of the last dialog shown.
    public get Last(): unknown
    {
        return this.Shown.length === 0 ? undefined : this.Shown[this.Shown.length - 1].Content
    }
}

// An in-memory tenant surface with the TenantApiClient's method names. Reads
// return the fixture arrays; writes record their arguments and update the
// fixtures. `Failure` (when set) makes every call reject with it; `FailOn`
// makes one named method reject. Log streams and event handlers are kept so a
// test can push into them.
export class FakeTenantApi
{
    public Hives: HiveDto[] = []
    public Environments: EnvironmentDto[] = []
    public Health: HiveHealthDto[] = []
    public Manifests: ManifestDto[] = []
    public Rollout: HiveRolloutDto = { targetVersion: undefined, environments: [] }
    public Ledger: AdoptionLedgerDto[] = []
    public Snapshots = new Map<string, AdminSnapshotDto>()
    public Tokens = new Map<string, ServiceTokenSummaryDto[]>()
    public SecurityModels = new Map<string, SecurityModelDto | null>()
    // Per environment; a missing one answers an empty catalog.
    public SecurityCatalogs = new Map<string, SecurityCatalogDto>()
    // Keyed by environment, then team id.
    public TeamMembers = new Map<string, Map<string, TeamMemberDto[]>>()
    public SecurityChanges = new Map<string, SecurityChangesDto[]>()
    public Graphs = new Map<string, GraphDto[]>()
    public ProfileDto: TenantProfileDto | undefined
    public EmailDomains: EmailDomainsDto = { domains: ['acme.test'], editable: true, inHive: false, pending: [] }
    public OnVerifyEmailDomain: ((domain: string) => void) | undefined
    public IssuedTokenValue = 'fixture-issued-token'
    public Failure: Error | undefined
    public readonly FailOn = new Map<string, Error>()
    public readonly Calls: Array<[string, ...unknown[]]> = []
    // Push delivers a chunk; Late delivers one even after the stream closed (a
    // frame already in flight); ServerClose closes it from the server side.
    public readonly LogStreams: Array<{ Name: string, Push: (text: string) => void, Late: (text: string) => void, ServerClose: () => void, Closed: boolean }> = []
    public readonly EventHandlers: Array<(ev: TenantEvent) => void> = []
    public LogoutCount = 0
    // What the shell's session service subscribes to and reads, as the real client (an AppSessionClient) has them.
    public readonly Unauthorized = new Signal<ApiError>()
    public readonly Forbidden = new Signal<ApiError>()
    public readonly Config = TenantShell.Config
    public readonly ChangesPassword = false

    // The configuration repository: each component's descriptor options, its versions' documents (version n at
    // index n - 1), its targets and its applies. SaveRefusal, when set, refuses the next save with it.
    public readonly ConfigurationOptions = new Map<string, ConfigurationOptionDto[]>()
    public readonly ConfigurationDocuments = new Map<string, unknown[]>()
    public readonly ConfigurationTargets = new Map<string, ConfigurationTargetDto[]>()
    public readonly ConfigurationApplies = new Map<string, ConfigurationApplyDto[]>()
    public ConfigurationDiff: ConfigurationDiffDto = { from: 0, to: 1, changes: [] }
    public ApplyOutcome = ConfigurationApplyOutcome.Applied
    public ApplyDetail: string | null = null

    // Seeds a component with its documents (versions 1..n) and its target environments (nothing applied yet).
    public WithConfiguration(component: string, documents: unknown[], environments: string[] = [], options: ConfigurationOptionDto[] = []): this
    {
        this.ConfigurationDocuments.set(component, [...documents])
        this.ConfigurationOptions.set(component, options)
        this.ConfigurationTargets.set(component, environments.map(environment => ({
            environment, hive: 'hive-1', namespace: 'tenant-' + environment, deployment: component, applied: null,
        })))
        this.ConfigurationApplies.set(component, [])
        return this
    }

    public async ListConfigurationComponents(): Promise<ConfigurationComponentDto[]>
    {
        await this.Enter('ListConfigurationComponents')
        return [...this.ConfigurationDocuments.keys()].map(component => ({
            component, componentVersion: '1.0.0', descriptorDigest: 'sha256:' + component,
            head: this.HeadOf(component), targets: (this.ConfigurationTargets.get(component) ?? []).map(t => ({ ...t })),
        }))
    }

    public async GetConfigurationComponent(component: string): Promise<ConfigurationComponentDetailDto>
    {
        await this.Enter('GetConfigurationComponent', component)
        const documents = this.ConfigurationDocuments.get(component)
        if (documents === undefined)
        {
            throw new ApiError(404, 'unknown component')
        }
        return {
            component, componentVersion: '1.0.0', descriptorDigest: 'sha256:' + component,
            options: this.ConfigurationOptions.get(component) ?? [],
            versions: documents.map((_, i) => this.Summary(i + 1)),
            applies: [...(this.ConfigurationApplies.get(component) ?? [])],
        }
    }

    public async GetConfigurationVersion(component: string, version: number): Promise<ConfigurationVersionDto>
    {
        await this.Enter('GetConfigurationVersion', component, version)
        const document = this.ConfigurationDocuments.get(component)?.[version - 1]
        if (document === undefined)
        {
            throw new ApiError(404, 'unknown version')
        }
        return { ...this.Summary(version), document }
    }

    public async DiffConfigurationVersions(component: string, from: number, to: number): Promise<ConfigurationDiffDto>
    {
        await this.Enter('DiffConfigurationVersions', component, from, to)
        return { ...this.ConfigurationDiff, from, to }
    }

    // Recorded as ['SaveConfigurationVersion', component, basedOn, document, comment]; a basedOn that is not the head is a 409.
    public async SaveConfigurationVersion(component: string, basedOn: number, document: unknown, comment: string): Promise<ConfigurationVersionSummaryDto>
    {
        await this.Enter('SaveConfigurationVersion', component, basedOn, document, comment)
        const head = this.HeadOf(component) ?? 0
        if (basedOn !== head)
        {
            throw new ApiError(409, 'The head moved.', undefined, { error: 'The head moved.', head })
        }
        const documents = this.ConfigurationDocuments.get(component) ?? []
        documents.push(document)
        this.ConfigurationDocuments.set(component, documents)
        return this.Summary(documents.length)
    }

    public async ApplyConfigurationVersion(component: string, version: number, environment: string): Promise<ConfigurationApplyDto>
    {
        await this.Enter('ApplyConfigurationVersion', component, version, environment)
        const record: ConfigurationApplyDto = {
            id: 'apply-' + String(this.Calls.length), version, environment, outcome: this.ApplyOutcome, requestedBy: 'owner@example.test',
            requestedAt: '2026-11-20T10:00:00.000Z', completedAt: '2026-11-20T10:00:01.000Z', detail: this.ApplyDetail,
        }
        this.ConfigurationApplies.get(component)?.unshift(record)
        const target = this.ConfigurationTargets.get(component)?.find(t => t.environment === environment)
        if (target !== undefined && this.ApplyOutcome === ConfigurationApplyOutcome.Applied)
        {
            target.applied = version
        }
        return record
    }

    private HeadOf(component: string): number | null
    {
        const count = this.ConfigurationDocuments.get(component)?.length ?? 0
        return count === 0 ? null : count
    }

    private Summary(version: number): ConfigurationVersionSummaryDto
    {
        return { version, componentVersion: '1.0.0', descriptorDigest: 'sha256:d', author: 'owner@example.test', createdAt: '2026-11-0' + String(version % 10) + 'T09:00:00.000Z', comment: 'v' + String(version) }
    }

    public WithHive(id: string, displayName: string = 'Hive ' + id): this
    {
        this.Hives.push({
            id, tenantId: 'tenant-1', displayName, cluster: { backend: 'aks', mode: 'attach' },
            registry: { mode: 'pull' }, createdAt: '2026-01-01T00:00:00.000Z',
        })
        return this
    }

    public WithEnvironment(name: string, status: EnvStatus = EnvStatus.Running, hiveId: string = 'hive-1', image?: string): this
    {
        this.Environments.push({
            name, template: Template.DevBlank, type: EnvType.Runtime, environmentId: 'env-' + name, hiveId,
            tenantId: 'tenant-1', hostPort: 0, status, createdAt: '2026-01-01T00:00:00.000Z',
            httpUrl: 'https://' + name + '.example.test', wsUrl: 'wss://' + name + '.example.test',
        })
        if (image !== undefined)
        {
            this.Health.push({ environmentName: name, ready: true, runningImage: image, detail: 'ok' })
            this.Rollout.environments.push({ environmentName: name, runningImage: image, obsolete: false, ready: true })
        }
        return this
    }

    public WithManifest(id: string, image: string, extra: Partial<ManifestDto> = {}): this
    {
        this.Manifests.push({ id, image, publishedAt: '2026-10-0' + (this.Manifests.length + 1) + 'T00:00:00.000Z', ...extra })
        return this
    }

    public AsClient(): TenantApiClient
    {
        return this as unknown as TenantApiClient
    }

    public Count(method: string): number
    {
        return this.Calls.filter(c => c[0] === method).length
    }

    public Push(ev: TenantEvent): void
    {
        for (const h of [...this.EventHandlers])
        {
            h(ev)
        }
    }

    public async Profile(): Promise<TenantProfileDto>
    {
        await this.Enter('Profile')
        if (this.ProfileDto === undefined)
        {
            throw new ApiError(404, 'no profile')
        }
        return this.ProfileDto
    }

    // Recorded as ['GetEmailDomains']; answers EmailDomains.
    public async GetEmailDomains(): Promise<EmailDomainsDto>
    {
        await this.Enter('GetEmailDomains')
        return this.CopyEmailDomains()
    }

    // Recorded as ['SetEmailDomains', domains]; stores the list as given (lower-cased, like the server) and answers it. Like the
    // control plane, a domain that was not approved before is pending (an in-hive console reports none pending).
    public async SetEmailDomains(domains: readonly string[]): Promise<EmailDomainsDto>
    {
        await this.Enter('SetEmailDomains', [...domains])
        const previous = this.EmailDomains
        const approved = new Set(previous.domains.filter(d => !previous.pending.includes(d)))
        const next = domains.map(d => d.toLowerCase())
        const pending = previous.inHive ? [] : next.filter(d => !approved.has(d)).sort()
        const surviving = (previous.verifications ?? []).filter(v => next.includes(v.domain))
        this.EmailDomains = { domains: next, editable: previous.editable, inHive: previous.inHive, pending, verifications: surviving }
        return this.CopyEmailDomains()
    }

    // Recorded as ['VerifyEmailDomain', domain]; runs OnVerifyEmailDomain (which may change EmailDomains, like a DNS check would)
    // and answers the refreshed view.
    public async VerifyEmailDomain(domain: string): Promise<EmailDomainsDto>
    {
        await this.Enter('VerifyEmailDomain', domain)
        this.OnVerifyEmailDomain?.(domain)
        return this.CopyEmailDomains()
    }

    private CopyEmailDomains(): EmailDomainsDto
    {
        const e = this.EmailDomains
        const copy: EmailDomainsDto = { domains: [...e.domains], editable: e.editable, inHive: e.inHive, pending: [...e.pending] }
        if (e.verifications !== undefined)
        {
            copy.verifications = e.verifications.map(v => ({ ...v }))
        }
        return copy
    }

    public async Logout(): Promise<void>
    {
        await this.Enter('Logout')
        this.LogoutCount++
    }

    public async ListHives(): Promise<HiveDto[]>
    {
        await this.Enter('ListHives')
        return [...this.Hives]
    }

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        await this.Enter('ListEnvironments')
        return this.Environments.map(e => ({ ...e }))
    }

    public async CreateEnvironment(params: CreateEnvironmentParams): Promise<EnvironmentDto>
    {
        await this.Enter('CreateEnvironment', params)
        if (this.Environments.some(e => e.name === params.name))
        {
            throw new ApiError(409, 'environment exists')
        }
        this.WithEnvironment(params.name, EnvStatus.Unknown)
        return { ...this.Environments[this.Environments.length - 1] }
    }

    public async ListManifests(): Promise<ManifestDto[]>
    {
        await this.Enter('ListManifests')
        return [...this.Manifests]
    }

    public async GetRollout(hiveId: string): Promise<HiveRolloutDto>
    {
        await this.Enter('GetRollout', hiveId)
        return { targetVersion: this.Rollout.targetVersion, environments: [...this.Rollout.environments] }
    }

    public async GetHealth(hiveId: string): Promise<HiveHealthDto[]>
    {
        await this.Enter('GetHealth', hiveId)
        return [...this.Health]
    }

    public async ListHiveLedger(hiveId: string): Promise<readonly AdoptionLedgerDto[]>
    {
        await this.Enter('ListHiveLedger', hiveId)
        return [...this.Ledger]
    }

    public async ListLedger(hiveId: string): Promise<readonly AdoptionLedgerDto[]>
    {
        await this.Enter('ListLedger', hiveId)
        return [...this.Ledger]
    }

    public async SelectTarget(hiveId: string, version: string): Promise<void>
    {
        await this.Enter('SelectTarget', hiveId, version)
        this.Rollout.targetVersion = version
    }

    public async StartEnvironment(name: string): Promise<EnvironmentDto>
    {
        return await this.Lifecycle('StartEnvironment', name, EnvStatus.Running)
    }

    public async StopEnvironment(name: string): Promise<EnvironmentDto>
    {
        return await this.Lifecycle('StopEnvironment', name, EnvStatus.Stopped)
    }

    public async RestartEnvironment(name: string): Promise<EnvironmentDto>
    {
        return await this.Lifecycle('RestartEnvironment', name, EnvStatus.Running)
    }

    public async DeleteEnvironment(name: string): Promise<void>
    {
        await this.Enter('DeleteEnvironment', name)
        this.Environments = this.Environments.filter(e => e.name !== name)
    }

    public async GetAdminSnapshot(env: string): Promise<AdminSnapshotDto>
    {
        await this.Enter('GetAdminSnapshot', env)
        const snapshot = this.Snapshots.get(env) ?? { accounts: [], grants: [] }
        return { accounts: snapshot.accounts.map(a => ({ ...a })), grants: snapshot.grants.map(g => ({ ...g })) }
    }

    public async CreateAccount(env: string, params: CreateAccountParams): Promise<void>
    {
        await this.Enter('CreateAccount', env, params)
        this.SnapshotFor(env).accounts.push({ principalId: params.principalId, email: params.email, disabled: false })
    }

    public async DisableAccount(env: string, principalId: string): Promise<void>
    {
        await this.Enter('DisableAccount', env, principalId)
        const account = this.SnapshotFor(env).accounts.find(a => a.principalId === principalId)
        if (account !== undefined)
        {
            account.disabled = true
        }
    }

    public async GrantRole(env: string, grant: GrantMutationDto): Promise<void>
    {
        await this.Enter('GrantRole', env, grant)
        this.SnapshotFor(env).grants.push({ subject: grant.subject, role: grant.role, resourceKind: grant.resourceKind ?? 'tenant', resourcePath: grant.resourcePath ?? [] })
    }

    public async RevokeRole(env: string, grant: GrantMutationDto): Promise<void>
    {
        await this.Enter('RevokeRole', env, grant)
        const snapshot = this.SnapshotFor(env)
        snapshot.grants = snapshot.grants.filter(g => !(g.subject === grant.subject && g.role === grant.role))
    }

    public async ListTokens(env: string): Promise<ServiceTokenSummaryDto[]>
    {
        await this.Enter('ListTokens', env)
        return (this.Tokens.get(env) ?? []).map(t => ({ ...t }))
    }

    public async IssueToken(env: string, params: IssueTokenParams): Promise<TokenIssuedDto>
    {
        await this.Enter('IssueToken', env, params)
        const tokenRef = 'ref-' + String(this.Count('IssueToken'))
        const list = this.Tokens.get(env) ?? []
        list.push({ tokenRef, principalId: params.principalId, scopes: params.scopes, expiresAt: null, revoked: false })
        this.Tokens.set(env, list)
        return { tokenRef, token: this.IssuedTokenValue, principalId: params.principalId, scopes: params.scopes, expiresAt: null }
    }

    public async RevokeToken(env: string, tokenRef: string): Promise<void>
    {
        await this.Enter('RevokeToken', env, tokenRef)
        const token = (this.Tokens.get(env) ?? []).find(t => t.tokenRef === tokenRef)
        if (token !== undefined)
        {
            token.revoked = true
        }
    }

    public async GetSecurityModel(env: string): Promise<SecurityModelDto | null>
    {
        await this.Enter('GetSecurityModel', env)
        const model = this.SecurityModels.get(env)
        return model === undefined || model === null ? null : structuredClone(model)
    }

    public async SetSecurityModel(env: string, model: SecurityModelDto): Promise<void>
    {
        await this.Enter('SetSecurityModel', env, model)
        this.SecurityModels.set(env, structuredClone(model))
    }

    public async GetSecurityCatalog(env: string): Promise<SecurityCatalogDto>
    {
        await this.Enter('GetSecurityCatalog', env)
        return structuredClone(this.SecurityCatalogs.get(env) ?? { roles: [], concepts: [], securedFields: [], profiles: [] })
    }

    public async ListTeamMembers(env: string, teamId: string): Promise<TeamMemberDto[]>
    {
        await this.Enter('ListTeamMembers', env, teamId)
        return structuredClone(this.TeamMembers.get(env)?.get(teamId) ?? [])
    }

    public async ListSecurityChanges(env: string): Promise<SecurityChangesDto[]>
    {
        await this.Enter('ListSecurityChanges', env)
        return structuredClone(this.SecurityChanges.get(env) ?? [])
    }

    // Recorded as ['ListGraphs', env]; answers copies of Graphs[env].
    public async ListGraphs(env: string): Promise<GraphDto[]>
    {
        await this.Enter('ListGraphs', env)
        return (this.Graphs.get(env) ?? []).map(g => ({ ...g }))
    }

    // Recorded as ['CreateGraph', env, params]; a name already listed answers the route's 409, else the graph is
    // appended with no packages.
    public async CreateGraph(env: string, params: CreateGraphParams): Promise<GraphDto>
    {
        await this.Enter('CreateGraph', env, params)
        const list = this.Graphs.get(env) ?? []
        if (list.some(g => g.name === params.name))
        {
            throw new ApiError(409, 'A graph with that name already exists in this environment.')
        }
        const graph: GraphDto = { name: params.name, description: params.description, createdAt: '2026-11-06T12:00:00.000Z', packageCount: 0 }
        list.push(graph)
        this.Graphs.set(env, list)
        return { ...graph }
    }

    // Recorded as ['DeleteGraph', env, graph]; removes it.
    public async DeleteGraph(env: string, graph: string): Promise<void>
    {
        await this.Enter('DeleteGraph', env, graph)
        this.Graphs.set(env, (this.Graphs.get(env) ?? []).filter(g => g.name !== graph))
    }

    public OnEvent(handler: (ev: TenantEvent) => void): () => void
    {
        this.EventHandlers.push(handler)
        return () =>
        {
            const i = this.EventHandlers.indexOf(handler)
            if (i >= 0)
            {
                this.EventHandlers.splice(i, 1)
            }
        }
    }

    public OpenLogStream(name: string, onChunk: (text: string) => void, onClose?: () => void): () => void
    {
        const stream = {
            Name: name,
            Push: (text: string) => { if (!stream.Closed) { onChunk(text) } },
            Late: (text: string) => { onChunk(text) },
            ServerClose: () => { stream.Closed = true; onClose?.() },
            Closed: false,
        }
        this.LogStreams.push(stream)
        return () => { stream.Closed = true }
    }

    private SnapshotFor(env: string): AdminSnapshotDto
    {
        let snapshot = this.Snapshots.get(env)
        if (snapshot === undefined)
        {
            snapshot = { accounts: [], grants: [] }
            this.Snapshots.set(env, snapshot)
        }
        return snapshot
    }

    private async Lifecycle(method: string, name: string, status: EnvStatus): Promise<EnvironmentDto>
    {
        await this.Enter(method, name)
        const env = this.Environments.find(e => e.name === name)
        if (env === undefined)
        {
            throw new ApiError(404, 'no such environment')
        }
        env.status = status
        return { ...env }
    }

    private async Enter(method: string, ...args: unknown[]): Promise<void>
    {
        this.Calls.push([method, ...args])
        await Promise.resolve()
        const failure = this.FailOn.get(method) ?? this.Failure
        if (failure !== undefined)
        {
            throw failure
        }
    }
}

// A provider with a real ContentHostService and an initialized session over a
// fake tenant surface.
export class TenantTestHost
{
    public static readonly AllCapabilities: AdminCapabilitiesDto = { envs: true, adopt: true, access: true, settings: true }
    public static readonly Subject = 'principal-1'
    public static readonly TenantId = 'tenant-1'
    public static readonly Email = 'owner@example.test'

    public readonly Provider = new ServiceProvider()
    public readonly Reloader = new FakeReloader()
    public readonly Session: TenantSessionService

    // `capabilities` null: the profile could not be read (permissive).
    public constructor(api: FakeTenantApi, capabilities: AdminCapabilitiesDto | null = TenantTestHost.AllCapabilities)
    {
        this.Provider.register(ContentHostService.Key, (p) => new ContentHostService(p))
        this.Session = new TenantSessionService(this.Provider)
        this.Session.Initialize(api.AsClient(), TenantTestHost.SessionFor(), this.Reloader,
            capabilities === null ? undefined : TenantTestHost.Profile(capabilities))
        this.Provider.registerInstance(TenantSessionService.Key, this.Session)
    }

    // The session the console's host reports: the realm's subject with the tenant, email and role claims.
    public static SessionFor(email: string | null = TenantTestHost.Email, roles: readonly string[] = ['admin']): AppSession
    {
        const claims: Record<string, readonly string[]> = { tenant: [TenantTestHost.TenantId], roles, app_roles: [] }
        if (email !== null)
        {
            claims.email = [email]
        }
        return AppSession.FromWire({ subject: TenantTestHost.Subject, claims }, TenantShell.Config)
    }

    public static Profile(capabilities: AdminCapabilitiesDto): TenantProfileDto
    {
        return {
            principalId: 'principal-1', email: 'owner@example.test', roleLabel: 'Tenant admin',
            tenant: { id: 'tenant-1', displayName: 'Example Tenant', organisation: 'Example Org' },
            hive: { id: 'hive-1', displayName: 'Example Hive' }, capabilities, ownerContact: 'owner@example.test',
        }
    }

    public get Host(): ContentHostService
    {
        return this.Provider.getRequired(ContentHostService.Key)
    }

    // Registers a FakeDialogService under DialogService.Key.
    public UseDialogs(): FakeDialogService
    {
        const dialogs = new FakeDialogService(this.Provider)
        this.Provider.registerInstance(DialogService.Key, dialogs)
        return dialogs
    }

    // Registers a ClipboardService whose writes land in the returned array.
    public UseClipboard(): string[]
    {
        const written: string[] = []
        this.Provider.registerInstance(ClipboardService.Key, new ClipboardService(this.Provider, async (text) => { written.push(text) }))
        return written
    }
}

// A rail over real NavigationService selection, for section round-trips.
export class TestRail
{
    public readonly Navigation: NavigationService

    public constructor(private readonly provider: ServiceProvider)
    {
        this.Navigation = new NavigationService(provider)
        provider.registerInstance(NavigationService.Key, this.Navigation)
    }

    public Select(section: ServiceToken<unknown>): void
    {
        const existing = this.Navigation.Items.ToArray().find(i => i instanceof Capability && i.ServiceKey === section)
        if (existing !== undefined)
        {
            this.Navigation.SelectedItem = existing
            return
        }
        const capability = new Capability()
        capability.ServiceKey = section
        this.Navigation.SelectedItem = capability
    }

    // Adds a rail item for a section, as PopulateFromModules would; a section
    // can then bring itself to the front through it.
    public Add(section: ServiceToken<unknown>): Capability
    {
        const capability = new Capability()
        capability.ServiceKey = section
        this.Navigation.Items.Add(capability)
        return capability
    }
}
