import { ServiceProvider, type ServiceToken } from '@pragmatic-tech-ai/mural/runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { Capability } from '@pragmatic-tech-ai/mural/framework/shell/module.js'
import { ClipboardService } from '@pragmatic-tech-ai/mural/framework/shell/services/clipboard-service.js'
import { ContentHostService } from '@pragmatic-tech-ai/mural/framework/shell/services/content-host-service.js'
import { DialogService, type DialogOptions } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import { ApiError, type ControlPlaneClient } from '../../api-client.js'
import { OperatorContext } from '../../operator-context.js'
import { AgentInstallState, AgentInstallStep, ConsoleInstallState, ConsoleInstallStep, EmailDomainSource, type AgentInstallStatusDto, type ConsoleInstallStatusDto, type TenantEmailDomainsDto } from '../../portal-types.js'
import type { ConsoleRemovalDto, HiveConsoleSpecDto, HiveDeleteOutcomeDto, InHiveOwnerPasswordDto, OwnerPasswordResetDto, PasswordChangedDto } from '../../portal-types.js'
import type { ActivityDto, ClientDto, CreatedTenantDto, FleetHiveDto, GatingDto, HiveBootstrapDto, HiveDto, HiveRolloutDto, LedgerDto, ManifestDto, ObservationDto, OperatorSummaryDto, PolicyDto, ProvisionInputDto, ProvisionResultDto, SelectionDto, TenantDto } from '../../portal-types.js'
import { DownloadService } from '../download-service.js'
import type { IPageReloader } from '../page-reloader.js'
import { PollScheduling, type IPollScheduler } from '../poll-scheduler.js'
import { PortalSessionService } from '../portal-session-service.js'

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

    // Every string reachable from a view-model: its exposed properties, and,
    // recursively, the properties of any plain object or view-model they hold
    // (functions and already-visited objects are skipped). Objects in `skip`
    // (e.g. a fake control plane holding fixture values) are not visited.
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

    // True when any exposed property is a command (has Execute and CanExecute).
    public static HasCommand(target: object): boolean
    {
        return Inspect.PropertyValues(target).some(v =>
            typeof v === 'object' && v !== null && typeof (v as { Execute?: unknown }).Execute === 'function'
            && typeof (v as { CanExecute?: unknown }).CanExecute === 'function')
    }
}

// A poll scheduler driven by hand: Schedule queues the poll; RunPending runs
// every queued poll still live (not disposed), as the timer would.
export class FakePollScheduler implements IPollScheduler
{
    public readonly Delays: number[] = []
    private queue: FakeScheduledPoll[] = []

    public Schedule(delayMs: number, poll: () => void): IDisposable
    {
        this.Delays.push(delayMs)
        const scheduled = new FakeScheduledPoll(poll)
        this.queue.push(scheduled)
        return scheduled
    }

    // How many queued polls are still live.
    public get Pending(): number
    {
        return this.queue.filter(p => p.Live).length
    }

    public RunPending(): void
    {
        const due = this.queue
        this.queue = []
        for (const p of due)
        {
            p.Run()
        }
    }
}

// One queued fake poll; disposing it cancels it.
export class FakeScheduledPoll implements IDisposable
{
    private live = true

    public constructor(private readonly poll: () => void)
    {
    }

    public get Live(): boolean
    {
        return this.live
    }

    public Run(): void
    {
        if (this.live)
        {
            this.live = false
            this.poll()
        }
    }

    public dispose(): void
    {
        this.live = false
    }
}

// A DialogService stand-in modelled on the real one: records each Show, one
// dialog open at a time (a new Show supersedes the open one, resolving it
// undefined), Close resolves whichever dialog is open now, and Dismiss is the
// Escape / title-bar X path (resolves the open dialog with undefined).
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

// An in-memory control plane for section tests: list methods answer from the
// arrays; mutating methods record their arguments and update the arrays, or
// throw Failure when it is set.
export class FakeControlPlane
{
    public Clients: ClientDto[] = []
    public Tenants: TenantDto[] = []
    public Hives: HiveDto[] = []
    public Fleet: FleetHiveDto[] = []
    public Rollouts: HiveRolloutDto[] = []
    public Policies: PolicyDto[] = []
    public Ledger: LedgerDto[] = []
    public Observations: ObservationDto[] = []
    public Manifests: ManifestDto[] = []
    public Gating: GatingDto[] = []
    public Activity: ActivityDto[] = []
    public Operators: OperatorSummaryDto[] = []
    public Selections: SelectionDto[] = []
    public OwnerPassword = 'fixture-owner-password'
    public ResetPassword = 'fixture-reset-password'
    public AgentToken = 'fixture-agent-token'
    public ReissuedToken = 'fixture-reissued-token'
    // While set, the bootstrap read fails with it (e.g. a 409 for an agent channel that is off).
    public BootstrapFailure: Error | undefined
    // What the bootstrap says about the automatic install (true: a Local hive on a control plane that installs it).
    public AutoInstall = false
    // The automatic install: each StartAgentInstall answers StartReply (or throws StartFailure);
    // each GetAgentInstall answers the next of InstallReplies, the last one repeating (none: null).
    public StartReply: AgentInstallStatusDto = FakeControlPlane.InstallStatus(AgentInstallState.Installing, AgentInstallStep.PreparingCluster)
    public StartFailure: Error | undefined
    public InstallReplies: Array<AgentInstallStatusDto | null> = []
    public InstallReadFailure: Error | undefined
    public readonly InstallStarts: string[] = []
    public InstallReads = 0
    public readonly Reissued: string[] = []
    // The in-hive console: its settings writes and removals, its install (each start answers ConsoleStartReply; each
    // read the next of ConsoleInstallReplies, the last one repeating, none: null) and its Owner password resets. While
    // ConsoleFailure is set, every console write fails with it.
    public readonly ConsoleSaves: Array<[string, HiveConsoleSpecDto]> = []
    public readonly ConsoleRemovals: string[] = []
    // What a console removal reports as kept in the cluster.
    public ConsoleRemovalRetained: string[] = []
    // A console removal's notice (the kept objects could not be listed), when set.
    public ConsoleRemovalNotice: string | undefined
    public ConsoleFailure: Error | undefined
    public ConsoleStartReply: ConsoleInstallStatusDto = FakeControlPlane.ConsoleStatus(ConsoleInstallState.Installing, ConsoleInstallStep.CheckingAgent)
    public ConsoleInstallReplies: Array<ConsoleInstallStatusDto | null> = []
    public readonly ConsoleInstallStarts: string[] = []
    public ConsoleInstallReads = 0
    public InHiveOwnerPassword = 'fixture-in-hive-owner-password'
    public readonly InHiveOwnerResets: string[] = []
    public ProvisionCalls = 0
    public readonly Provisioned: ProvisionInputDto[] = []
    public Failure: Error | undefined
    // The control plane serves the operator roster to Full operators only.
    public DenyOperators = false
    public OperatorListCalls = 0
    // While set, a policy write whose call text starts with this fails.
    public FailPolicyCall: string | undefined
    // Each operator-management write as 'Method email [argument]', in call order.
    public readonly OperatorCalls: string[] = []
    // The own-password changes asked for, as [current, new, confirm]; a set PasswordChangeFailure fails the next ones.
    public readonly PasswordChanges: Array<[string, string, string]> = []
    public PasswordChangeFailure: Error | undefined
    public PasswordChangeHold: Promise<void> | undefined
    public PasswordReply: PasswordChangedDto = { ok: true, otherSessionsEnded: true }
    public SessionAlive = true
    public SessionChecks = 0
    public readonly CreatedClients: Array<[string, string, string | undefined]> = []
    public readonly CreatedTenants: Array<[string, string, string, string]> = []
    public readonly CreatedHives: HiveDto[] = []
    public readonly Deleted: string[] = []
    // While set, a hive delete without force fails with it (e.g. the agent could not be removed from its cluster).
    public DeleteHiveFailure: Error | undefined
    // The ids deleted with force (delete anyway), in call order; they are in Deleted too.
    public readonly ForcedDeletes: string[] = []
    // The tenant Owner password reset: its reply, its calls, and an optional failure.
    public OwnerResetEmail = 'owner@acme.test'
    public OwnerResetPassword = 'fixture-reset-owner-password'
    public OwnerResetFailure: Error | undefined
    // When set, the reset reports that the Owner's sessions could not be ended, with this warning.
    public OwnerResetWarning: string | undefined
    public readonly OwnerResets: string[] = []
    // Tenant email domains: the report per tenant (none: an editable control-plane tenant with no domains), the PUTs
    // as [tenantId, domains], the approvals and revokes as 'Approve|Revoke tenantId domain', and, while set,
    // EmailDomainsReadFailure fails every read and EmailDomainsFailure every write.
    public readonly EmailDomainReports = new Map<string, TenantEmailDomainsDto>()
    public readonly EmailDomainSaves: Array<[string, string[]]> = []
    public readonly EmailDomainActions: string[] = []
    public EmailDomainsReadFailure: Error | undefined
    public EmailDomainsFailure: Error | undefined
    public EmailDomainReads = 0
    // What a hive delete replies.
    public DeleteOutcome: HiveDeleteOutcomeDto = { ok: true, retained: [] }
    public readonly Published: Array<[string, string, string | undefined, string | undefined]> = []
    public readonly Withdrawals: Array<[string, boolean, string | undefined]> = []
    public readonly GateCalls: Array<[string, string]> = []
    public readonly UngateCalls: Array<[string, string]> = []
    // Each policy write as 'Method id [argument]', in call order.
    public readonly PolicyCalls: string[] = []
    public readonly CreatedOperators: Array<[string, string, string]> = []
    private createGate: Promise<void> | undefined
    private releaseCreates: (() => void) | undefined

    // Seeds a client.
    public WithClient(id: string, displayName: string = 'Client ' + id): this
    {
        this.Clients.push({ id, displayName, createdAt: '2026-10-01T00:00:00.000Z' })
        return this
    }

    // Seeds a tenant of a client.
    public WithTenant(id: string, clientId: string, displayName: string = 'Tenant ' + id): this
    {
        this.Tenants.push({ id, clientId, displayName, createdAt: '2026-10-02T00:00:00.000Z' })
        return this
    }

    // Seeds a hive serving a tenant: its record, and its fleet entry (checked in
    // a minute ago, reporting one environment per `ready` flag).
    public WithHive(id: string, tenantId: string, ready: boolean[] = [true], credentialRef?: string): this
    {
        this.Hives.push({
            id, tenantId, displayName: 'Hive ' + id,
            cluster: { backend: 'local', mode: 'attach' },
            registry: { mode: 'attach', credentialRef },
        })
        const tenant = this.Tenants.find(t => t.id === tenantId)
        const client = tenant === undefined ? undefined : this.Clients.find(c => c.id === tenant.clientId)
        this.Fleet.push({
            id,
            displayName: 'Hive ' + id,
            tenant: tenant === undefined ? null : { id: tenant.id, displayName: tenant.displayName },
            client: client === undefined ? null : { id: client.id, displayName: client.displayName },
            clusterBackend: 'local',
            clusterMode: 'attach',
            lastSeen: new Date(Date.now() - 60 * 1000).toISOString(),
            environments: ready.map((r, i) => ({ name: 'env' + i, ready: r, image: 'img:' + i, detail: '' })),
        })
        return this
    }

    public async ListClients(): Promise<ClientDto[]>
    {
        return [...this.Clients]
    }

    public async ListTenants(clientId?: string): Promise<TenantDto[]>
    {
        return this.Tenants.filter(t => clientId === undefined || t.clientId === clientId)
    }

    public async ListHives(): Promise<HiveDto[]>
    {
        return [...this.Hives]
    }

    public async ListFleet(): Promise<FleetHiveDto[]>
    {
        return [...this.Fleet]
    }

    public async ListRollouts(): Promise<HiveRolloutDto[]>
    {
        return [...this.Rollouts]
    }

    public async ListPolicies(): Promise<PolicyDto[]>
    {
        return [...this.Policies]
    }

    // A hive's ledger: entries for that hive (entries without a hive count for every hive).
    public async ListHiveLedger(hiveId: string): Promise<LedgerDto[]>
    {
        return this.Ledger.filter(l => l.hiveId === undefined || l.hiveId === hiveId)
    }

    // Seeds a published version (stable, signed, published on the given day).
    public WithManifest(id: string, image: string, extra: Partial<ManifestDto> = {}): this
    {
        this.Manifests.push({ id, image, publishedAt: '2026-10-10T00:00:00.000Z', channel: 'stable', signed: true, ...extra })
        return this
    }

    // Copies, as the wire would: a page never sees a later write through a shared object.
    public async ListManifests(): Promise<ManifestDto[]>
    {
        return this.Manifests.map(m => ({ ...m }))
    }

    public async PublishManifest(version: string, image: string, notes?: string, channel?: string): Promise<ManifestDto>
    {
        this.ThrowIfFailing()
        this.Published.push([version, image, notes, channel])
        const manifest: ManifestDto = { id: version, image, notes, publishedAt: new Date().toISOString(), channel: channel as ManifestDto['channel'] }
        this.Manifests.push(manifest)
        return manifest
    }

    public async SetManifestWithdrawn(version: string, withdraw: boolean, reason?: string): Promise<ManifestDto>
    {
        this.ThrowIfFailing()
        this.Withdrawals.push([version, withdraw, reason])
        const manifest = this.Manifests.find(m => m.id === version)
        if (manifest === undefined)
        {
            throw new Error('unknown version ' + version)
        }
        manifest.withdrawn = withdraw
        manifest.withdrawal = withdraw ? { reason: reason ?? '', actor: 'op@example.test', at: '2026-10-20T00:00:00.000Z' } : undefined
        return manifest
    }

    public async ListGating(): Promise<GatingDto[]>
    {
        return [...this.Gating]
    }

    public async Gate(tenantId: string, version: string): Promise<void>
    {
        this.ThrowIfFailing()
        this.GateCalls.push([tenantId, version])
        this.Gating.push({ tenantId, version, gatedAt: '2026-10-21T00:00:00.000Z' })
    }

    public async Ungate(tenantId: string, version: string): Promise<void>
    {
        this.ThrowIfFailing()
        this.UngateCalls.push([tenantId, version])
        this.Gating = this.Gating.filter(g => !(g.tenantId === tenantId && g.version === version))
    }

    public async SetTenantChannels(tenantId: string, channels: string[]): Promise<PolicyDto>
    {
        return this.WritePolicy('SetTenantChannels ' + tenantId + ' ' + channels.join(','), tenantId, undefined, p => { p.channels = channels as PolicyDto['channels'] })
    }

    public async SetTenantMinVersion(tenantId: string, version: string): Promise<PolicyDto>
    {
        return this.WritePolicy('SetTenantMinVersion ' + tenantId + ' ' + version, tenantId, undefined, p => { p.minVersion = version })
    }

    public async ClearTenantMinVersion(tenantId: string): Promise<PolicyDto>
    {
        return this.WritePolicy('ClearTenantMinVersion ' + tenantId, tenantId, undefined, p => { delete p.minVersion })
    }

    public async SetTenantHold(tenantId: string, reason: string): Promise<PolicyDto>
    {
        return this.WritePolicy('SetTenantHold ' + tenantId + ' ' + reason, tenantId, undefined, p => { p.hold = { reason, actor: 'op', at: '2026-10-22T00:00:00.000Z' } })
    }

    public async ClearTenantHold(tenantId: string): Promise<PolicyDto>
    {
        return this.WritePolicy('ClearTenantHold ' + tenantId, tenantId, undefined, p => { delete p.hold })
    }

    public async SetHiveChannels(hiveId: string, channels: string[]): Promise<PolicyDto>
    {
        return this.WritePolicy('SetHiveChannels ' + hiveId + ' ' + channels.join(','), this.TenantOfHive(hiveId), hiveId, p => { p.channels = channels as PolicyDto['channels'] })
    }

    public async SetHiveMinVersion(hiveId: string, version: string): Promise<PolicyDto>
    {
        return this.WritePolicy('SetHiveMinVersion ' + hiveId + ' ' + version, this.TenantOfHive(hiveId), hiveId, p => { p.minVersion = version })
    }

    public async ClearHiveMinVersion(hiveId: string): Promise<PolicyDto>
    {
        return this.WritePolicy('ClearHiveMinVersion ' + hiveId, this.TenantOfHive(hiveId), hiveId, p => { delete p.minVersion })
    }

    public async SetHiveHold(hiveId: string, reason: string): Promise<PolicyDto>
    {
        return this.WritePolicy('SetHiveHold ' + hiveId + ' ' + reason, this.TenantOfHive(hiveId), hiveId, p => { p.hold = { reason, actor: 'op', at: '2026-10-22T00:00:00.000Z' } })
    }

    public async ClearHiveHold(hiveId: string): Promise<PolicyDto>
    {
        return this.WritePolicy('ClearHiveHold ' + hiveId, this.TenantOfHive(hiveId), hiveId, p => { delete p.hold })
    }

    public async ListActivity(): Promise<ActivityDto[]>
    {
        return [...this.Activity]
    }

    public async ListOperators(): Promise<OperatorSummaryDto[]>
    {
        this.OperatorListCalls++
        if (this.DenyOperators)
        {
            throw new ApiError(403, 'forbidden')
        }
        return this.Operators.map(o => ({ ...o }))
    }

    public async SetOperatorRole(email: string, role: string): Promise<void>
    {
        this.ThrowIfFailing()
        this.OperatorCalls.push('SetOperatorRole ' + email + ' ' + role)
        this.Operator(email).role = role
    }

    public async SetOperatorDisabled(email: string, disabled: boolean): Promise<void>
    {
        this.ThrowIfFailing()
        this.OperatorCalls.push('SetOperatorDisabled ' + email + ' ' + String(disabled))
        this.Operator(email).disabled = disabled
    }

    public async RevokeOperatorSessions(email: string): Promise<void>
    {
        this.ThrowIfFailing()
        this.OperatorCalls.push('RevokeOperatorSessions ' + email)
    }

    // Answers PasswordReply; while PasswordChangeHold is set, the reply waits for it (a submit in flight).
    public async ChangeOwnPassword(currentPassword: string, newPassword: string, confirmPassword: string): Promise<PasswordChangedDto>
    {
        await this.PasswordChangeHold
        if (this.PasswordChangeFailure !== undefined)
        {
            throw this.PasswordChangeFailure
        }
        this.PasswordChanges.push([currentPassword, newPassword, confirmPassword])
        return this.PasswordReply
    }

    // The session probe: the signed-in operator while SessionAlive, else null (401).
    public async Session(): Promise<{ email: string; principalId: string; role: string } | null>
    {
        this.SessionChecks++
        return this.SessionAlive ? { email: 'op@example.test', principalId: 'p1', role: OperatorContext.FullWireRole } : null
    }

    // Held by HoldCreates, like a create.
    public async ResetOperatorPassword(email: string): Promise<{ password: string }>
    {
        await this.createGate
        this.ThrowIfFailing()
        this.OperatorCalls.push('ResetOperatorPassword ' + email)
        return { password: this.ResetPassword }
    }

    public async ListSelections(): Promise<SelectionDto[]>
    {
        return [...this.Selections]
    }

    private Operator(email: string): OperatorSummaryDto
    {
        const found = this.Operators.find(o => o.email === email)
        if (found === undefined)
        {
            throw new Error('unknown operator ' + email)
        }
        return found
    }

    public async CreateOperator(email: string, password: string, role: string): Promise<void>
    {
        await this.createGate
        this.ThrowIfFailing()
        this.CreatedOperators.push([email, password, role])
        this.Operators.push({ email, role })
    }

    private TenantOfHive(hiveId: string): string
    {
        return this.Hives.find(h => h.id === hiveId)?.tenantId ?? ''
    }

    private WritePolicy(call: string, tenantId: string, hiveId: string | undefined, change: (policy: PolicyDto) => void): PolicyDto
    {
        this.ThrowIfFailing()
        if (this.FailPolicyCall !== undefined && call.startsWith(this.FailPolicyCall))
        {
            throw new Error('refused: ' + call)
        }
        this.PolicyCalls.push(call)
        let policy = this.Policies.find(p => p.tenantId === tenantId && p.hiveId === hiveId)
        if (policy === undefined)
        {
            policy = hiveId === undefined ? { tenantId } : { tenantId, hiveId }
            this.Policies.push(policy)
        }
        change(policy)
        return policy
    }

    public async ListHiveObservations(): Promise<ObservationDto[]>
    {
        return [...this.Observations]
    }

    // Holds every create (and password reset) in flight until Release() is called.
    public HoldCreates(): void
    {
        this.createGate = new Promise<void>(resolve => { this.releaseCreates = resolve })
    }

    public Release(): void
    {
        this.releaseCreates?.()
        this.createGate = undefined
        this.releaseCreates = undefined
    }

    public async CreateClient(id: string, displayName: string, subscriptionRef?: string): Promise<ClientDto>
    {
        await this.createGate
        this.ThrowIfFailing()
        this.CreatedClients.push([id, displayName, subscriptionRef])
        const client = { id, displayName, subscriptionRef, createdAt: new Date().toISOString() }
        this.Clients.push(client)
        return client
    }

    public async CreateTenant(id: string, clientId: string, displayName: string, ownerEmail: string): Promise<CreatedTenantDto>
    {
        await this.createGate
        this.ThrowIfFailing()
        this.CreatedTenants.push([id, clientId, displayName, ownerEmail])
        this.Tenants.push({ id, clientId, displayName })
        return { id, clientId, displayName, owner: { email: ownerEmail, principalId: 'p-' + id, password: this.OwnerPassword } }
    }

    // Records the hive and lists it in the fleet (never checked in yet).
    public async CreateHive(input: HiveDto): Promise<HiveDto>
    {
        await this.createGate
        this.ThrowIfFailing()
        this.CreatedHives.push(input)
        this.AddHive(input)
        return input
    }

    // Stands up a client, its tenant and the tenant's hive in one call, as
    // the control plane's provision route does; answers the one-time Owner
    // password and agent token. Held by HoldCreates, failed by Failure.
    public async Provision(input: ProvisionInputDto): Promise<ProvisionResultDto>
    {
        this.ProvisionCalls++
        await this.createGate
        this.ThrowIfFailing()
        this.Provisioned.push(input)
        let client = this.Clients.find(c => c.id === input.client.id)
        if (!('existing' in input.client))
        {
            client = { ...input.client, createdAt: '2026-10-25T00:00:00.000Z' }
            this.Clients.push(client)
        }
        let tenant = this.Tenants.find(t => t.id === input.tenant.id)
        let secrets: ProvisionResultDto['secrets'] = { agentToken: this.AgentToken }
        if (!('existing' in input.tenant))
        {
            tenant = { id: input.tenant.id, clientId: input.client.id, displayName: input.tenant.displayName }
            this.Tenants.push(tenant)
            secrets = { ownerEmail: input.tenant.ownerEmail, ownerPassword: this.OwnerPassword, agentToken: this.AgentToken }
        }
        if (client === undefined || tenant === undefined)
        {
            throw new ApiError(404, 'Unknown client or tenant')
        }
        const hive: HiveDto = { ...input.hive, tenantId: tenant.id }
        this.AddHive(hive)
        return { client, tenant, hive, secrets }
    }

    private AddHive(input: HiveDto): void
    {
        this.Hives.push(input)
        const tenant = this.Tenants.find(t => t.id === input.tenantId)
        const client = tenant === undefined ? undefined : this.Clients.find(c => c.id === tenant.clientId)
        this.Fleet.push({
            id: input.id,
            displayName: input.displayName,
            tenant: tenant === undefined ? null : { id: tenant.id, displayName: tenant.displayName },
            client: client === undefined ? null : { id: client.id, displayName: client.displayName },
            clusterBackend: input.cluster.backend,
            clusterMode: input.cluster.mode,
            lastSeen: null,
            environments: [],
        })
    }

    public async DeleteClient(id: string): Promise<void>
    {
        this.ThrowIfFailing()
        this.Deleted.push(id)
        this.Clients = this.Clients.filter(c => c.id !== id)
    }

    public async DeleteTenant(id: string): Promise<void>
    {
        this.ThrowIfFailing()
        this.Deleted.push(id)
        this.Tenants = this.Tenants.filter(t => t.id !== id)
    }

    public async ResetOwnerPassword(tenantId: string): Promise<OwnerPasswordResetDto>
    {
        this.ThrowIfFailing()
        if (this.OwnerResetFailure !== undefined)
        {
            throw this.OwnerResetFailure
        }
        this.OwnerResets.push(tenantId)
        const reset: OwnerPasswordResetDto = { ownerEmail: this.OwnerResetEmail, ownerPassword: this.OwnerResetPassword, sessionsRevoked: this.OwnerResetWarning === undefined }
        if (this.OwnerResetWarning !== undefined)
        {
            reset.warning = this.OwnerResetWarning
        }
        return reset
    }

    public async GetTenantEmailDomains(tenantId: string): Promise<TenantEmailDomainsDto>
    {
        this.EmailDomainReads++
        if (this.EmailDomainsReadFailure !== undefined)
        {
            throw this.EmailDomainsReadFailure
        }
        return FakeControlPlane.CopyReport(this.EmailDomainReport(tenantId))
    }

    public async SetTenantEmailDomains(tenantId: string, domains: readonly string[]): Promise<TenantEmailDomainsDto>
    {
        this.ThrowIfEmailDomainsFailing()
        this.EmailDomainSaves.push([tenantId, [...domains]])
        const report = { ...this.EmailDomainReport(tenantId), domains: [...domains] }
        this.EmailDomainReports.set(tenantId, report)
        return FakeControlPlane.CopyReport(report)
    }

    public async ApproveTenantEmailDomain(tenantId: string, domain: string): Promise<TenantEmailDomainsDto>
    {
        return this.SetApproval(tenantId, domain, true)
    }

    public async RevokeTenantEmailDomain(tenantId: string, domain: string): Promise<TenantEmailDomainsDto>
    {
        return this.SetApproval(tenantId, domain, false)
    }

    private SetApproval(tenantId: string, domain: string, approved: boolean): TenantEmailDomainsDto
    {
        this.ThrowIfEmailDomainsFailing()
        this.EmailDomainActions.push((approved ? 'Approve ' : 'Revoke ') + tenantId + ' ' + domain)
        const report = this.EmailDomainReport(tenantId)
        const next = { ...report, approvals: (report.approvals ?? []).map(a => a.domain === domain ? { ...a, approved } : a) }
        this.EmailDomainReports.set(tenantId, next)
        return FakeControlPlane.CopyReport(next)
    }

    private EmailDomainReport(tenantId: string): TenantEmailDomainsDto
    {
        return this.EmailDomainReports.get(tenantId) ?? { tenantId, domains: [], source: EmailDomainSource.Tenant, editable: true, sharedWith: [] }
    }

    private static CopyReport(report: TenantEmailDomainsDto): TenantEmailDomainsDto
    {
        const copy: TenantEmailDomainsDto = { ...report, domains: [...report.domains], sharedWith: [...report.sharedWith] }
        if (report.approvals !== undefined)
        {
            copy.approvals = report.approvals.map(a => ({ ...a, sharedWith: [...a.sharedWith] }))
        }
        return copy
    }

    private ThrowIfEmailDomainsFailing(): void
    {
        if (this.EmailDomainsFailure !== undefined)
        {
            throw this.EmailDomainsFailure
        }
    }

    public async DeleteHive(id: string, force: boolean = false): Promise<HiveDeleteOutcomeDto>
    {
        this.ThrowIfFailing()
        if (force)
        {
            this.ForcedDeletes.push(id)
        }
        else if (this.DeleteHiveFailure !== undefined)
        {
            throw this.DeleteHiveFailure
        }
        this.Deleted.push(id)
        this.Hives = this.Hives.filter(h => h.id !== id)
        this.Fleet = this.Fleet.filter(h => h.id !== id)
        return { ...this.DeleteOutcome }
    }

    public async GetHiveBootstrap(hiveId: string): Promise<HiveBootstrapDto>
    {
        if (this.BootstrapFailure !== undefined)
        {
            throw this.BootstrapFailure
        }
        return {
            hiveId,
            fileName: 'bootstrap-' + hiveId + '.json',
            manifest: '{"apiVersion":"v1","kind":"List","items":[]}',
            namespace: 'pragmatic-system',
            agentName: 'pragmatic-hive-' + hiveId + '-agent',
            hiveSelector: 'pragmatic/hive=' + hiveId,
            tokenSecretName: 'pragmatic-hive-' + hiveId + '-agent-token',
            tokenSecretKey: 'token',
            channelUrl: 'http://host.docker.internal:7001',
            autoInstall: this.AutoInstall,
        }
    }

    // An install status at a step (startedAt fixed; finishedAt once settled).
    public static InstallStatus(state: AgentInstallState, step: AgentInstallStep, error?: string): AgentInstallStatusDto
    {
        const status: AgentInstallStatusDto = { state, step, startedAt: '2026-11-03T10:00:00.000Z' }
        if (state !== AgentInstallState.Installing)
        {
            status.finishedAt = '2026-11-03T10:05:00.000Z'
        }
        if (error !== undefined)
        {
            status.error = error
        }
        return status
    }

    public async StartAgentInstall(hiveId: string): Promise<AgentInstallStatusDto>
    {
        if (this.StartFailure !== undefined)
        {
            throw this.StartFailure
        }
        this.InstallStarts.push(hiveId)
        return { ...this.StartReply }
    }

    public async GetAgentInstall(_hiveId: string): Promise<AgentInstallStatusDto | null>
    {
        this.InstallReads++
        if (this.InstallReadFailure !== undefined)
        {
            throw this.InstallReadFailure
        }
        const next = this.InstallReplies.length > 1 ? this.InstallReplies.shift() : this.InstallReplies[0]
        return next === undefined || next === null ? null : { ...next }
    }

    public async ReissueAgentToken(hiveId: string): Promise<string>
    {
        this.ThrowIfFailing()
        this.Reissued.push(hiveId)
        return this.ReissuedToken
    }

    // A console install status at a step (startedAt fixed; finishedAt once settled).
    public static ConsoleStatus(state: ConsoleInstallState, step: ConsoleInstallStep, extra: Partial<ConsoleInstallStatusDto> = {}): ConsoleInstallStatusDto
    {
        const status: ConsoleInstallStatusDto = { state, step, startedAt: '2026-11-04T10:00:00.000Z', ...extra }
        if (state !== ConsoleInstallState.Installing)
        {
            status.finishedAt = '2026-11-04T10:05:00.000Z'
        }
        return status
    }

    public async SetHiveConsole(hiveId: string, spec: HiveConsoleSpecDto): Promise<HiveDto>
    {
        if (this.ConsoleFailure !== undefined)
        {
            throw this.ConsoleFailure
        }
        this.ConsoleSaves.push([hiveId, spec])
        return this.UpdateHive(hiveId, h => ({ ...h, console: spec }))
    }

    public async RemoveHiveConsole(hiveId: string): Promise<ConsoleRemovalDto>
    {
        if (this.ConsoleFailure !== undefined)
        {
            throw this.ConsoleFailure
        }
        this.ConsoleRemovals.push(hiveId)
        const hive = this.UpdateHive(hiveId, h =>
        {
            const copy = { ...h }
            delete copy.console
            return copy
        })
        return this.ConsoleRemovalNotice === undefined
            ? { hive, retained: this.ConsoleRemovalRetained }
            : { hive, retained: this.ConsoleRemovalRetained, notice: this.ConsoleRemovalNotice }
    }

    public async StartConsoleInstall(hiveId: string): Promise<ConsoleInstallStatusDto>
    {
        if (this.ConsoleFailure !== undefined)
        {
            throw this.ConsoleFailure
        }
        this.ConsoleInstallStarts.push(hiveId)
        return { ...this.ConsoleStartReply }
    }

    public async GetConsoleInstall(_hiveId: string): Promise<ConsoleInstallStatusDto | null>
    {
        this.ConsoleInstallReads++
        const next = this.ConsoleInstallReplies.length > 1 ? this.ConsoleInstallReplies.shift() : this.ConsoleInstallReplies[0]
        return next === undefined || next === null ? null : { ...next }
    }

    public async ResetInHiveOwnerPassword(hiveId: string): Promise<InHiveOwnerPasswordDto>
    {
        if (this.ConsoleFailure !== undefined)
        {
            throw this.ConsoleFailure
        }
        this.InHiveOwnerResets.push(hiveId)
        return { ownerEmail: this.OwnerResetEmail, ownerPassword: this.InHiveOwnerPassword }
    }

    private UpdateHive(hiveId: string, change: (hive: HiveDto) => HiveDto): HiveDto
    {
        const at = this.Hives.findIndex(h => h.id === hiveId)
        if (at < 0)
        {
            throw new ApiError(ApiError.NotFoundStatus, 'not found')
        }
        const next = change(this.Hives[at] as HiveDto)
        this.Hives[at] = next
        return { ...next }
    }

    public AsClient(): ControlPlaneClient
    {
        return this as unknown as ControlPlaneClient
    }

    private ThrowIfFailing(): void
    {
        if (this.Failure !== undefined)
        {
            throw this.Failure
        }
    }
}

// A ServiceProvider with a real ContentHostService and an initialized session.
export class PortalTestHost
{
    public static readonly Email = 'op@example.test'

    public readonly Provider = new ServiceProvider()
    public readonly Reloader = new FakeReloader()
    public readonly Session: PortalSessionService

    public constructor(client: ControlPlaneClient, wireRole: string = OperatorContext.FullWireRole)
    {
        this.Provider.register(ContentHostService.Key, (p) => new ContentHostService(p))
        this.Session = new PortalSessionService(this.Provider)
        this.Session.Initialize(client, PortalTestHost.Email, OperatorContext.FromWire(wireRole), this.Reloader)
        this.Provider.registerInstance(PortalSessionService.Key, this.Session)
    }

    // A host whose client is never called.
    public static WithoutClient(): PortalTestHost
    {
        return new PortalTestHost({} as ControlPlaneClient)
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

    // Registers a DownloadService whose saves land in the returned array as [fileName, text].
    public UseDownloads(): Array<[string, string]>
    {
        const saved: Array<[string, string]> = []
        this.Provider.registerInstance(DownloadService.Key, new DownloadService(this.Provider, (fileName, text) => { saved.push([fileName, text]) }))
        return saved
    }

    // Registers a hand-driven poll scheduler under PollScheduling.Key.
    public UsePolls(): FakePollScheduler
    {
        const polls = new FakePollScheduler()
        this.Provider.registerInstance(PollScheduling.Key, polls)
        return polls
    }

    // Registers a ClipboardService whose writes land in the returned array.
    public UseClipboard(): string[]
    {
        const written: string[] = []
        this.Provider.registerInstance(ClipboardService.Key, new ClipboardService(this.Provider, async (text) => { written.push(text) }))
        return written
    }
}

// A real NavigationService rail over a provider: register section types, then
// Select one to make it the rail's active service (activating it).
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
