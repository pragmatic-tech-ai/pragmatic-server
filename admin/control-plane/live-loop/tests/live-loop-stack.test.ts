import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LiveLoopStack, LiveLoopStackAgent, LiveLoopStackNames, LiveLoopStackSeed } from '../live-loop-stack.js'
import type { ApiAnswer, IOperatorApi } from '../operator-api-client.js'

class FakeOperatorApi implements IOperatorApi
{
    public readonly Calls: { method: string; path: string; body: unknown }[] = []

    public constructor(private readonly answers: Record<string, ApiAnswer>)
    {
    }

    public async Login(): Promise<void>
    {
    }

    public async Call(method: string, path: string, body?: unknown): Promise<ApiAnswer>
    {
        this.Calls.push({ method, path, body })
        return this.answers[path] ?? { status: 404, body: undefined }
    }
}

class SeedFx
{
    public static readonly OneTime = 'one-time-pw'

    public static Answers(): Record<string, ApiAnswer>
    {
        return {
            '/api/clients': { status: 201, body: {} },
            '/api/tenants': { status: 201, body: { owner: { email: LiveLoopStackNames.OwnerEmail, password: SeedFx.OneTime } } },
            '/api/hives': { status: 201, body: {} },
        }
    }
}

describe('LiveLoopStackSeed', () =>
{
    it('creates the client, the tenant with the short owner email and the hive attached to the kind context, and returns the one-time password', async () =>
    {
        const api = new FakeOperatorApi(SeedFx.Answers())
        assert.equal(await new LiveLoopStackSeed(api).Seed(), SeedFx.OneTime)
        assert.deepEqual(api.Calls.map(c => c.method + ' ' + c.path), ['POST /api/clients', 'POST /api/tenants', 'POST /api/hives'])
        assert.deepEqual(api.Calls[1]!.body, { id: 'e2e', clientId: 'e2e-client', displayName: 'E2E', ownerEmail: 'o@t.io' })
        assert.deepEqual(api.Calls[2]!.body, {
            id: 'e2e-hive', tenantId: 'e2e', displayName: 'E2E Hive',
            cluster: { backend: 'local', mode: 'attach', configRef: 'kind-pragmatic-e2e' },
            registry: { mode: 'attach' },
        })
    })

    it('stops at the first refused step, naming it without any secret', async () =>
    {
        const answers = SeedFx.Answers()
        answers['/api/tenants'] = { status: 409, body: { error: 'exists' } }
        const api = new FakeOperatorApi(answers)
        await assert.rejects(new LiveLoopStackSeed(api).Seed(), /seed step failed: \/api\/tenants status 409/)
        assert.equal(api.Calls.length, 2)
    })

    it('refuses a tenant answer without the owner password', async () =>
    {
        const answers = SeedFx.Answers()
        answers['/api/tenants'] = { status: 201, body: {} }
        await assert.rejects(new LiveLoopStackSeed(new FakeOperatorApi(answers)).Seed(), /seed step failed: \/api\/tenants/)
    })
})

/** An operator API that answers each call to a path from that path's queue (the last answer repeats). */
class ScriptedOperatorApi implements IOperatorApi
{
    public readonly Calls: { method: string; path: string }[] = []

    public constructor(private readonly answers: Record<string, ApiAnswer[]>)
    {
    }

    public async Login(): Promise<void>
    {
    }

    public async Call(method: string, path: string): Promise<ApiAnswer>
    {
        this.Calls.push({ method, path })
        const queue = this.answers[method + ' ' + path] ?? []
        return (queue.length > 1 ? queue.shift() : queue[0]) ?? { status: 404, body: undefined }
    }
}

class AgentFx
{
    public static readonly Path = '/api/hives/e2e-hive/agent-install'
    public static readonly Started: ApiAnswer = { status: 202, body: { state: 'installing', step: 'preparing-cluster' } }
    public static readonly Waiting: ApiAnswer = { status: 200, body: { state: 'installing', step: 'waiting-for-check-in' } }
    public static readonly Connected: ApiAnswer = { status: 200, body: { state: 'connected', step: 'waiting-for-check-in' } }

    public static Agent(api: IOperatorApi, deadlineMs: number = 1_000): LiveLoopStackAgent
    {
        return new LiveLoopStackAgent(api, { pollMs: 1, deadlineMs })
    }
}

describe('LiveLoopStackAgent', () =>
{
    it('starts the hive agent install and waits until the hive has checked in', async () =>
    {
        const api = new ScriptedOperatorApi({ ['POST ' + AgentFx.Path]: [AgentFx.Started], ['GET ' + AgentFx.Path]: [AgentFx.Waiting, AgentFx.Waiting, AgentFx.Connected] })
        await AgentFx.Agent(api).Install()
        assert.deepEqual(api.Calls.map(c => c.method), ['POST', 'GET', 'GET', 'GET'])
        assert.ok(api.Calls.every(c => c.path === AgentFx.Path))
    })

    it('fails with the installer\'s own error when the install fails', async () =>
    {
        const failed: ApiAnswer = { status: 200, body: { state: 'failed', step: 'applying-agent', error: 'kubectl apply refused' } }
        const api = new ScriptedOperatorApi({ ['POST ' + AgentFx.Path]: [AgentFx.Started], ['GET ' + AgentFx.Path]: [failed] })
        await assert.rejects(AgentFx.Agent(api).Install(), /hive agent install failed at applying-agent: kubectl apply refused/)
    })

    it('fails naming the status when the install cannot start (e.g. the agent channel is off)', async () =>
    {
        const api = new ScriptedOperatorApi({ ['POST ' + AgentFx.Path]: [{ status: 409, body: { error: 'channel off' } }] })
        await assert.rejects(AgentFx.Agent(api).Install(), /hive agent install did not start: status 409: channel off/)
    })

    it('gives up after its deadline when the hive never checks in', async () =>
    {
        const api = new ScriptedOperatorApi({ ['POST ' + AgentFx.Path]: [AgentFx.Started], ['GET ' + AgentFx.Path]: [AgentFx.Waiting] })
        await assert.rejects(AgentFx.Agent(api, 20).Install(), /hive agent did not check in in time; last step waiting-for-check-in/)
    })
})

describe('LiveLoopStack.ReleaseEnv', () =>
{
    const N = LiveLoopStackNames

    it('points the release catalogue at the developer\'s GHCR read credential when that file exists', () =>
    {
        const seen: string[] = []
        const out = LiveLoopStack.ReleaseEnv({}, path => { seen.push(path); return true })
        assert.deepEqual(out, { [N.ReleaseCredentialEnvVar]: N.ReleaseCredentialFile })
        assert.deepEqual(seen, [N.ReleaseCredentialFile])
    })

    it('adds nothing when the credential file is absent, so Refresh answers not configured', () =>
    {
        assert.deepEqual(LiveLoopStack.ReleaseEnv({}, () => false), {})
    })

    it('leaves an explicitly set credential file alone, and treats a blank one as unset', () =>
    {
        assert.deepEqual(LiveLoopStack.ReleaseEnv({ [N.ReleaseCredentialEnvVar]: 'C:/elsewhere.json' }, () => true), {})
        assert.deepEqual(LiveLoopStack.ReleaseEnv({ [N.ReleaseCredentialEnvVar]: '' }, () => true), { [N.ReleaseCredentialEnvVar]: N.ReleaseCredentialFile })
    })
})

describe('LiveLoopStack.Redact', () =>
{
    it('replaces the stack passwords in any failure text', () =>
    {
        const out = new LiveLoopStack().Redact('login failed for ' + LiveLoopStackNames.OwnerPassword + ' and ' + LiveLoopStackNames.OperatorPassword)
        assert.equal(out, 'login failed for *** and ***')
    })
})
