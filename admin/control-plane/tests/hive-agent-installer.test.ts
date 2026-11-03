import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    AgentInstallInProgressError,
    AgentInstallUnavailableError,
    HiveAgentInstaller,
    InstallState,
    InstallStep,
    type IInstallClock,
} from '../hive-agent-installer.js'
import type { IHiveOrchestrator, WorkloadHealth } from '../hive-orchestrator.js'
import { KubectlError, type IKubectl } from '../kubectl.js'
import type { EnvironmentWorkload } from '../environment-workload.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'
import { UnknownHiveError } from '../rollout-errors.js'

class FakeKubectl implements IKubectl
{
    public readonly Calls: string[][] = []
    public readonly Applied: string[] = []
    public readonly ServerApplied: string[] = []
    public ApplyError: Error | undefined
    public ServerApplyError: Error | undefined
    public RestartError: Error | undefined
    // Runs inside the restart, before it returns (e.g. a snapshot recorded meanwhile).
    public OnRestart: (() => void) | undefined

    public async Apply(manifestJson: string): Promise<void>
    {
        this.Calls.push(['Apply'])
        this.Applied.push(manifestJson)
        if (this.ApplyError !== undefined)
        {
            throw this.ApplyError
        }
    }

    public async ApplyServerSide(manifestJson: string): Promise<void>
    {
        this.Calls.push(['ApplyServerSide'])
        this.ServerApplied.push(manifestJson)
        if (this.ServerApplyError !== undefined)
        {
            throw this.ServerApplyError
        }
    }

    public async RolloutStatus(n: string, d: string): Promise<void> { this.Calls.push(['RolloutStatus', n, d]) }
    public async SetImage(n: string, d: string, c: string, i: string): Promise<void> { this.Calls.push(['SetImage', n, d, c, i]) }
    public async Scale(n: string, d: string, r: number): Promise<void> { this.Calls.push(['Scale', n, d, String(r)]) }
    public async ScaleStatefulSet(n: string, s: string, r: number): Promise<void> { this.Calls.push(['ScaleStatefulSet', n, s, String(r)]) }
    public async RolloutRestart(n: string, d: string): Promise<void> { this.Calls.push(['RolloutRestart', n, d]) }

    public async RolloutRestartSelector(n: string, s: string): Promise<void>
    {
        this.Calls.push(['RolloutRestartSelector', n, s])
        this.OnRestart?.()
        if (this.RestartError !== undefined)
        {
            throw this.RestartError
        }
    }

    public async Get(n: string, r: string): Promise<string>
    {
        this.Calls.push(['Get', n, r])
        return '{}'
    }

    public async DeleteManifest(_m: string): Promise<void> { }
    public async DeleteBySelector(_n: string, _r: string, _s: string): Promise<void> { }
    public async DeleteNamespace(n: string): Promise<void> { this.Calls.push(['DeleteNamespace', n]) }
}

class FakeOrchestrator implements IHiveOrchestrator
{
    public readonly Prepared: string[] = []
    public PrepareError: Error | undefined
    public OnPrepare: (() => void) | undefined

    public constructor(public readonly Kubectl: FakeKubectl)
    {
    }

    public async PrepareAgent(image: string): Promise<void>
    {
        this.Prepared.push(image)
        this.OnPrepare?.()
        if (this.PrepareError !== undefined)
        {
            throw this.PrepareError
        }
    }

    public async Apply(_w: EnvironmentWorkload): Promise<void> { }
    public async WaitHealthy(_w: EnvironmentWorkload): Promise<void> { }
    public async Health(_w: EnvironmentWorkload): Promise<WorkloadHealth> { return { ready: true, runningImage: undefined, detail: '' } }
    public async Roll(_w: EnvironmentWorkload, _image: string): Promise<void> { }
    public async Scale(_w: EnvironmentWorkload, _replicas: number): Promise<void> { }
    public async ScaleDatabase(_w: EnvironmentWorkload, _replicas: number): Promise<void> { }
    public async Teardown(_w: EnvironmentWorkload): Promise<void> { }
}

class FakeOrchestrators
{
    public readonly Kubectl = new FakeKubectl()
    public readonly Orchestrator = new FakeOrchestrator(this.Kubectl)
    public readonly Resolved: string[] = []

    public For(hive: HiveRecord): IHiveOrchestrator
    {
        this.Resolved.push(hive.id)
        return this.Orchestrator
    }
}

// Mints tokens short and dotted, so KubectlError's long-run redaction never matches them: only the
// installer's own exact-token scrub can keep them out of error text.
class FakeIssuer
{
    public readonly Minted: string[] = []
    public readonly Committed: Array<[string, string]> = []

    public NewAgentToken(): string
    {
        const token = 'tk.' + String(this.Minted.length) + '.Zq'
        this.Minted.push(token)
        return token
    }

    public async CommitAgentToken(hiveId: string, token: string): Promise<void>
    {
        this.Committed.push([hiveId, token])
    }
}

class FakeCheckIns
{
    public readonly Records = new Map<string, { reportedAt: string }>()

    public LatestRecord(hiveId: string): { reportedAt: string } | undefined
    {
        return this.Records.get(hiveId)
    }
}

// Virtual time: Delay advances it and yields; OnDelay runs after each advance.
class FakeClock implements IInstallClock
{
    public Ms = Date.parse('2026-11-03T10:00:00.000Z')
    public Delays = 0
    public OnDelay: (() => void) | undefined

    public Now(): number
    {
        return this.Ms
    }

    public async Delay(ms: number): Promise<void>
    {
        this.Ms += ms
        this.Delays++
        await new Promise(resolve => setImmediate(resolve))
        this.OnDelay?.()
    }
}

// Captures console.error while a test body runs.
class ErrorLog
{
    public static async Capture(body: () => Promise<void>): Promise<string>
    {
        const lines: string[] = []
        const original = console.error
        console.error = (...args: unknown[]) => { lines.push(args.map(a => String(a)).join(' ')) }
        try
        {
            await body()
        }
        finally
        {
            console.error = original
        }
        return lines.join('\n')
    }
}

class Fixture
{
    public static readonly ChannelUrl = 'http://host.docker.internal:7001'
    public static readonly PollMs = 2000
    public static readonly TimeoutMs = 60000
    public readonly Hives = new Map<string, HiveRecord>()
    public readonly Orchestrators = new FakeOrchestrators()
    public readonly Issuer = new FakeIssuer()
    public readonly CheckIns = new FakeCheckIns()
    public readonly Clock = new FakeClock()
    public readonly Installer: HiveAgentInstaller

    public constructor(channelOn: boolean = true)
    {
        const channelUrl = channelOn ? Fixture.ChannelUrl : undefined
        this.AddHive('h1', HiveBackend.Local, InfraMode.Attach)
        this.AddHive('kind1', HiveBackend.Local, InfraMode.Provision)
        this.AddHive('aks1', HiveBackend.Aks, InfraMode.Attach)
        this.Installer = new HiveAgentInstaller(
            { GetHive: (id: string) => this.Hives.get(id) },
            this.Orchestrators,
            this.Issuer,
            this.CheckIns,
            channelUrl,
            this.Clock,
            { pollIntervalMs: Fixture.PollMs, timeoutMs: Fixture.TimeoutMs })
    }

    public get Kubectl(): FakeKubectl
    {
        return this.Orchestrators.Kubectl
    }

    // The agent checks in (now, in virtual time) after this many poll delays.
    public CheckInAfter(delays: number, hiveId: string = 'h1'): void
    {
        this.Clock.OnDelay = () =>
        {
            if (this.Clock.Delays === delays)
            {
                this.CheckIns.Records.set(hiveId, { reportedAt: new Date(this.Clock.Ms).toISOString() })
            }
        }
    }

    private AddHive(id: string, backend: HiveBackend, mode: InfraMode): void
    {
        this.Hives.set(id, { id, tenantId: 't1', displayName: id, cluster: { backend, mode }, registry: { mode: InfraMode.Provision }, createdAt: '2026-01-01T00:00:00.000Z' })
    }
}

describe('HiveAgentInstaller', () =>
{
    it('runs every step in order and ends Connected once a check-in newer than the restart arrives', async () =>
    {
        const fx = new Fixture()
        fx.CheckInAfter(2)
        const started = fx.Installer.Start('h1')
        assert.equal(started.state, InstallState.Installing)
        assert.equal(started.startedAt, new Date(fx.Clock.Ms).toISOString())
        const done = await fx.Installer.WhenSettled('h1')
        assert.equal(done?.state, InstallState.Connected)
        assert.equal(done?.step, InstallStep.WaitingForCheckIn)
        assert.ok(done?.finishedAt !== undefined)
        assert.equal(done?.error, undefined)
        assert.deepEqual(fx.Orchestrators.Orchestrator.Prepared, [K8sManifestBuilder.AgentImage])
        // The token Secret goes server-side; the restart covers every deployment reading it (agent and tenant-admin).
        assert.deepEqual(fx.Kubectl.Calls, [['Apply'], ['ApplyServerSide'], ['RolloutRestartSelector', 'pragmatic-system', 'pragmatic/hive=h1']])
        const agent = JSON.parse(fx.Kubectl.Applied[0]!) as { kind: string; items: { kind: string }[] }
        assert.equal(agent.kind, 'List')
        assert.ok(agent.items.some(i => i.kind === 'Deployment'))
        assert.ok(fx.Kubectl.Applied[0]!.includes(Fixture.ChannelUrl))
        assert.deepEqual(fx.Issuer.Committed, [['h1', fx.Issuer.Minted[0]]])
        assert.deepEqual(fx.Installer.StatusFor('h1'), done)
    })

    it('stores the token in the agent Secret through a server-side apply on stdin, and commits it only after the Secret is stored', async () =>
    {
        const fx = new Fixture()
        fx.CheckInAfter(1)
        const order: string[] = []
        const commit = fx.Issuer.CommitAgentToken.bind(fx.Issuer)
        fx.Issuer.CommitAgentToken = async (hiveId: string, token: string) =>
        {
            order.push('commit after ' + fx.Kubectl.ServerApplied.length + ' secret apply')
            await commit(hiveId, token)
        }
        fx.Installer.Start('h1')
        await fx.Installer.WhenSettled('h1')
        const token = fx.Issuer.Minted[0]!
        const secret = JSON.parse(fx.Kubectl.ServerApplied[0]!) as { apiVersion: string; kind: string; type: string; metadata: { name: string; namespace: string }; stringData: Record<string, string> }
        assert.equal(secret.apiVersion, 'v1')
        assert.equal(secret.kind, 'Secret')
        assert.equal(secret.type, 'Opaque')
        assert.equal(secret.metadata.name, 'pragmatic-hive-h1-agent-token')
        assert.equal(secret.metadata.namespace, 'pragmatic-system')
        assert.deepEqual(secret.stringData, { token })
        assert.deepEqual(order, ['commit after 1 secret apply'])
        assert.ok(!fx.Kubectl.Applied[0]!.includes(token))
        assert.ok(!JSON.stringify(fx.Installer.StatusFor('h1')).includes(token))
    })

    it('a failed Secret apply never commits the new token, so the previous one stays valid', async () =>
    {
        const fx = new Fixture()
        fx.Kubectl.ServerApplyError = new KubectlError('error: secrets is forbidden')
        fx.Installer.Start('h1')
        const done = await fx.Installer.WhenSettled('h1')
        assert.equal(done?.state, InstallState.Failed)
        assert.equal(done?.step, InstallStep.StoringToken)
        assert.equal(fx.Issuer.Minted.length, 1)
        assert.deepEqual(fx.Issuer.Committed, [])
        assert.ok(!fx.Kubectl.Calls.some(c => c[0] === 'RolloutRestartSelector'))
    })

    it('a snapshot from before the install does not count as the check-in', async () =>
    {
        const fx = new Fixture()
        fx.CheckIns.Records.set('h1', { reportedAt: new Date(fx.Clock.Ms - 1000).toISOString() })
        fx.CheckInAfter(3)
        fx.Installer.Start('h1')
        const done = await fx.Installer.WhenSettled('h1')
        assert.equal(done?.state, InstallState.Connected)
        assert.equal(fx.Clock.Delays, 3)
    })

    it('a snapshot recorded while the restart runs (an old pod, old token) does not count: the cutoff is after the restart', async () =>
    {
        const fx = new Fixture()
        fx.Kubectl.OnRestart = () =>
        {
            fx.CheckIns.Records.set('h1', { reportedAt: new Date(fx.Clock.Ms).toISOString() })
            fx.Clock.Ms += 50
        }
        fx.CheckInAfter(2)
        fx.Installer.Start('h1')
        const done = await fx.Installer.WhenSettled('h1')
        assert.equal(done?.state, InstallState.Connected)
        assert.equal(fx.Clock.Delays, 2)
    })

    it('fails at WaitingForCheckIn when no check-in arrives in time, pointing at the agent pod and the image load', async () =>
    {
        const fx = new Fixture()
        fx.Installer.Start('h1')
        const done = await fx.Installer.WhenSettled('h1')
        assert.equal(done?.state, InstallState.Failed)
        assert.equal(done?.step, InstallStep.WaitingForCheckIn)
        assert.match(done?.error ?? '', /did not check in/)
        assert.match(done?.error ?? '', /image may still be loading/)
        assert.match(done?.error ?? '', /kubectl -n pragmatic-system get pods/)
        assert.ok(done?.finishedAt !== undefined)
        assert.equal(fx.Clock.Delays, Fixture.TimeoutMs / Fixture.PollMs)
    })

    it('a kubectl failure fails its step with the fixed message plus the redacted kubectl text; later steps never run', async () =>
    {
        const fx = new Fixture()
        fx.Kubectl.ApplyError = new KubectlError('error: connection refused to the cluster\npassword=hunter2')
        fx.Installer.Start('h1')
        const done = await fx.Installer.WhenSettled('h1')
        assert.equal(done?.state, InstallState.Failed)
        assert.equal(done?.step, InstallStep.ApplyingAgent)
        assert.match(done?.error ?? '', /^Could not apply the agent to the cluster/)
        assert.match(done?.error ?? '', /connection refused/)
        assert.ok(!(done?.error ?? '').includes('hunter2'))
        assert.equal(fx.Issuer.Minted.length, 0)
        assert.deepEqual(fx.Kubectl.Calls, [['Apply']])
    })

    it('a token kubectl echoes back is scrubbed from the status and never logged (the redaction alone would miss this short token)', async () =>
    {
        const fx = new Fixture()
        const mint = fx.Issuer.NewAgentToken.bind(fx.Issuer)
        fx.Issuer.NewAgentToken = () =>
        {
            const token = mint()
            fx.Kubectl.ServerApplyError = new KubectlError('error validating data: stringData.token value ' + token + ' rejected')
            return token
        }
        let done: Awaited<ReturnType<HiveAgentInstaller['WhenSettled']>>
        const log = await ErrorLog.Capture(async () =>
        {
            fx.Installer.Start('h1')
            done = await fx.Installer.WhenSettled('h1')
        })
        const token = fx.Issuer.Minted[0]!
        // The premise: KubectlError alone leaves this token in its text.
        assert.ok(new KubectlError('x ' + token).message.includes(token))
        assert.equal(done!?.state, InstallState.Failed)
        assert.equal(done!?.step, InstallStep.StoringToken)
        assert.match(done!?.error ?? '', /^Could not store the agent token/)
        assert.match(done!?.error ?? '', /\[REDACTED\]/)
        assert.ok(!JSON.stringify(done!).includes(token))
        assert.ok(log.length > 0)
        assert.ok(!log.includes(token))
    })

    it('a non-kubectl failure reports only the fixed step message, and the log carries no raw error text', async () =>
    {
        const fx = new Fixture()
        fx.Orchestrators.Orchestrator.PrepareError = new Error('kind exploded with secret-ish detail')
        let done: Awaited<ReturnType<HiveAgentInstaller['WhenSettled']>>
        const log = await ErrorLog.Capture(async () =>
        {
            fx.Installer.Start('kind1')
            done = await fx.Installer.WhenSettled('kind1')
        })
        assert.equal(done!?.state, InstallState.Failed)
        assert.equal(done!?.step, InstallStep.PreparingCluster)
        assert.equal(done!?.error, 'Could not prepare the cluster for the agent.')
        assert.match(log, /kind1/)
        assert.ok(!log.includes('secret-ish'))
    })

    it('a restart failure fails RestartingAgent', async () =>
    {
        const fx = new Fixture()
        fx.Kubectl.RestartError = new KubectlError('no deployments matched')
        fx.Installer.Start('h1')
        const done = await fx.Installer.WhenSettled('h1')
        assert.equal(done?.state, InstallState.Failed)
        assert.equal(done?.step, InstallStep.RestartingAgent)
        assert.match(done?.error ?? '', /^Could not restart the agent/)
    })

    it('a hive deleted mid-install stops the install before the next step: nothing applied, no token committed', async () =>
    {
        const fx = new Fixture()
        fx.Orchestrators.Orchestrator.OnPrepare = () => { fx.Hives.delete('h1') }
        fx.Installer.Start('h1')
        const done = await fx.Installer.WhenSettled('h1')
        assert.equal(done?.state, InstallState.Failed)
        assert.equal(done?.step, InstallStep.ApplyingAgent)
        assert.match(done?.error ?? '', /hive was deleted/)
        assert.deepEqual(fx.Kubectl.Calls, [])
        assert.deepEqual(fx.Issuer.Minted, [])
        assert.deepEqual(fx.Issuer.Committed, [])
    })

    it('one install at a time per hive (IsInstalling says so); Retry after a failure starts a fresh run', async () =>
    {
        const fx = new Fixture()
        fx.Kubectl.ApplyError = new Error('apply failed')
        assert.equal(fx.Installer.IsInstalling('h1'), false)
        fx.Installer.Start('h1')
        assert.equal(fx.Installer.IsInstalling('h1'), true)
        assert.throws(() => fx.Installer.Start('h1'), AgentInstallInProgressError)
        const failed = await fx.Installer.WhenSettled('h1')
        assert.equal(failed?.state, InstallState.Failed)
        assert.equal(fx.Installer.IsInstalling('h1'), false)
        fx.Kubectl.ApplyError = undefined
        fx.CheckInAfter(fx.Clock.Delays + 1)
        const retried = fx.Installer.Start('h1')
        assert.equal(retried.state, InstallState.Installing)
        assert.equal(retried.error, undefined)
        const done = await fx.Installer.WhenSettled('h1')
        assert.equal(done?.state, InstallState.Connected)
    })

    it('another hive may install while one is running', async () =>
    {
        const fx = new Fixture()
        fx.Installer.Start('h1')
        assert.equal(fx.Installer.Start('kind1').state, InstallState.Installing)
        assert.equal(fx.Installer.IsInstalling('aks1'), false)
    })

    it('refuses an unknown hive, a non-Local hive and a control plane whose agent channel is off', () =>
    {
        const fx = new Fixture()
        assert.throws(() => fx.Installer.Start('nope'), UnknownHiveError)
        assert.throws(() => fx.Installer.Start('aks1'), (e: unknown) => e instanceof AgentInstallUnavailableError && /not available for this hive/.test(e.message))
        const off = new Fixture(false)
        assert.throws(() => off.Installer.Start('h1'), (e: unknown) => e instanceof AgentInstallUnavailableError && /PRAGMATIC_AGENT_CHANNEL_PORT/.test(e.message))
        assert.equal(fx.Installer.StatusFor('aks1'), undefined)
        assert.deepEqual(fx.Orchestrators.Resolved, [])
    })

    it('StatusFor is undefined before any install; Supports is true for Local hives only', () =>
    {
        const fx = new Fixture()
        assert.equal(fx.Installer.StatusFor('h1'), undefined)
        assert.equal(fx.Installer.Supports(fx.Hives.get('h1')!), true)
        assert.equal(fx.Installer.Supports(fx.Hives.get('kind1')!), true)
        assert.equal(fx.Installer.Supports(fx.Hives.get('aks1')!), false)
        assert.equal(new Fixture(false).Installer.Supports(fx.Hives.get('h1')!), false)
    })

    it('a returned status is a copy: mutating it does not change the installer state', async () =>
    {
        const fx = new Fixture()
        const started = fx.Installer.Start('h1')
        started.state = InstallState.Connected
        assert.equal(fx.Installer.StatusFor('h1')?.state, InstallState.Installing)
    })
})
