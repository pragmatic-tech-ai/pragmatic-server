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
    // Fails the Nth Apply (1-based) with this error; 0 = never.
    public FailApplyAt = 0
    public ApplyError: Error = new Error('apply failed')
    public RestartError: Error | undefined

    public async Apply(manifestJson: string): Promise<void>
    {
        this.Calls.push(['Apply'])
        this.Applied.push(manifestJson)
        if (this.Applied.length === this.FailApplyAt)
        {
            throw this.ApplyError
        }
    }

    public async RolloutStatus(n: string, d: string): Promise<void> { this.Calls.push(['RolloutStatus', n, d]) }
    public async SetImage(n: string, d: string, c: string, i: string): Promise<void> { this.Calls.push(['SetImage', n, d, c, i]) }
    public async Scale(n: string, d: string, r: number): Promise<void> { this.Calls.push(['Scale', n, d, String(r)]) }
    public async ScaleStatefulSet(n: string, s: string, r: number): Promise<void> { this.Calls.push(['ScaleStatefulSet', n, s, String(r)]) }

    public async RolloutRestart(n: string, d: string): Promise<void>
    {
        this.Calls.push(['RolloutRestart', n, d])
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

    public async DeleteNamespace(n: string): Promise<void> { this.Calls.push(['DeleteNamespace', n]) }
}

class FakeOrchestrator implements IHiveOrchestrator
{
    public readonly Prepared: string[] = []
    public PrepareError: Error | undefined

    public constructor(public readonly Kubectl: FakeKubectl)
    {
    }

    public async PrepareAgent(image: string): Promise<void>
    {
        this.Prepared.push(image)
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

class FakeIssuer
{
    public static readonly TokenPrefix = 'AgentTok_'
    public readonly Issued: string[] = []

    public async RegisterHive(hiveId: string): Promise<string>
    {
        // Long and base64url-shaped, like the real token, so the KubectlError redaction applies to it.
        const token = FakeIssuer.TokenPrefix + hiveId + '_' + 'x9Q2'.repeat(10) + String(this.Issued.length)
        this.Issued.push(token)
        return token
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
    it('runs every step in order and ends Connected once a check-in newer than the token arrives', async () =>
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
        assert.deepEqual(fx.Kubectl.Calls, [['Apply'], ['Apply'], ['RolloutRestart', 'pragmatic-system', 'pragmatic-hive-h1-agent']])
        const agent = JSON.parse(fx.Kubectl.Applied[0]!) as { kind: string; items: { kind: string }[] }
        assert.equal(agent.kind, 'List')
        assert.ok(agent.items.some(i => i.kind === 'Deployment'))
        assert.ok(fx.Kubectl.Applied[0]!.includes(Fixture.ChannelUrl))
        assert.equal(fx.Issuer.Issued.length, 1)
        assert.deepEqual(fx.Installer.StatusFor('h1'), done)
    })

    it('stores the token in the agent Secret through stdin (Apply) only, never in any argument', async () =>
    {
        const fx = new Fixture()
        fx.CheckInAfter(1)
        fx.Installer.Start('h1')
        await fx.Installer.WhenSettled('h1')
        const token = fx.Issuer.Issued[0]!
        const secret = JSON.parse(fx.Kubectl.Applied[1]!) as { apiVersion: string; kind: string; type: string; metadata: { name: string; namespace: string }; stringData: Record<string, string> }
        assert.equal(secret.apiVersion, 'v1')
        assert.equal(secret.kind, 'Secret')
        assert.equal(secret.type, 'Opaque')
        assert.equal(secret.metadata.name, 'pragmatic-hive-h1-agent-token')
        assert.equal(secret.metadata.namespace, 'pragmatic-system')
        assert.deepEqual(secret.stringData, { token })
        assert.ok(!fx.Kubectl.Applied[0]!.includes(token))
        assert.ok(!JSON.stringify(fx.Kubectl.Calls).includes(token))
        assert.ok(!JSON.stringify(fx.Installer.StatusFor('h1')).includes(token))
    })

    it('a snapshot from before the token was issued does not count as the check-in', async () =>
    {
        const fx = new Fixture()
        fx.CheckIns.Records.set('h1', { reportedAt: new Date(fx.Clock.Ms - 1000).toISOString() })
        fx.CheckInAfter(3)
        fx.Installer.Start('h1')
        const done = await fx.Installer.WhenSettled('h1')
        assert.equal(done?.state, InstallState.Connected)
        assert.equal(fx.Clock.Delays, 3)
    })

    it('fails at WaitingForCheckIn when no check-in arrives before the timeout', async () =>
    {
        const fx = new Fixture()
        fx.Installer.Start('h1')
        const done = await fx.Installer.WhenSettled('h1')
        assert.equal(done?.state, InstallState.Failed)
        assert.equal(done?.step, InstallStep.WaitingForCheckIn)
        assert.match(done?.error ?? '', /did not check in/)
        assert.ok(done?.finishedAt !== undefined)
        assert.equal(fx.Clock.Delays, Fixture.TimeoutMs / Fixture.PollMs)
    })

    it('a kubectl failure fails its step with the fixed message plus the redacted kubectl text; later steps never run', async () =>
    {
        const fx = new Fixture()
        fx.Kubectl.FailApplyAt = 1
        fx.Kubectl.ApplyError = new KubectlError('error: connection refused to the cluster\npassword=hunter2')
        fx.Installer.Start('h1')
        const done = await fx.Installer.WhenSettled('h1')
        assert.equal(done?.state, InstallState.Failed)
        assert.equal(done?.step, InstallStep.ApplyingAgent)
        assert.match(done?.error ?? '', /^Could not apply the agent to the cluster/)
        assert.match(done?.error ?? '', /connection refused/)
        assert.ok(!(done?.error ?? '').includes('hunter2'))
        assert.equal(fx.Issuer.Issued.length, 0)
        assert.deepEqual(fx.Kubectl.Calls, [['Apply']])
    })

    it('a failure while storing the token never surfaces the token, even when kubectl echoes it', async () =>
    {
        const fx = new Fixture()
        fx.Kubectl.FailApplyAt = 2
        // The token is only known once issued: echo it back the way a chatty kubectl might.
        const issued = fx.Issuer.RegisterHive.bind(fx.Issuer)
        fx.Issuer.RegisterHive = async (hiveId: string) =>
        {
            const token = await issued(hiveId)
            fx.Kubectl.ApplyError = new KubectlError('error validating data: stringData.token ' + token + ' rejected')
            return token
        }
        fx.Installer.Start('h1')
        const done = await fx.Installer.WhenSettled('h1')
        const token = fx.Issuer.Issued[0]!
        assert.equal(done?.state, InstallState.Failed)
        assert.equal(done?.step, InstallStep.StoringToken)
        assert.match(done?.error ?? '', /^Could not store the agent token/)
        assert.ok(!(done?.error ?? '').includes(token))
        assert.ok(!JSON.stringify(done).includes(token))
    })

    it('a non-kubectl failure reports only the fixed step message, never the raw error text', async () =>
    {
        const fx = new Fixture()
        fx.Orchestrators.Orchestrator.PrepareError = new Error('kind exploded with secret-ish detail')
        fx.Installer.Start('kind1')
        const done = await fx.Installer.WhenSettled('kind1')
        assert.equal(done?.state, InstallState.Failed)
        assert.equal(done?.step, InstallStep.PreparingCluster)
        assert.equal(done?.error, 'Could not prepare the cluster for the agent.')
    })

    it('a restart failure fails RestartingAgent', async () =>
    {
        const fx = new Fixture()
        fx.Kubectl.RestartError = new KubectlError('deployments.apps "pragmatic-hive-h1-agent" not found')
        fx.Installer.Start('h1')
        const done = await fx.Installer.WhenSettled('h1')
        assert.equal(done?.state, InstallState.Failed)
        assert.equal(done?.step, InstallStep.RestartingAgent)
        assert.match(done?.error ?? '', /^Could not restart the agent/)
    })

    it('one install at a time per hive; Retry after a failure starts a fresh run', async () =>
    {
        const fx = new Fixture()
        fx.Kubectl.FailApplyAt = 1
        fx.Installer.Start('h1')
        assert.throws(() => fx.Installer.Start('h1'), AgentInstallInProgressError)
        const failed = await fx.Installer.WhenSettled('h1')
        assert.equal(failed?.state, InstallState.Failed)
        fx.Kubectl.FailApplyAt = 0
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
