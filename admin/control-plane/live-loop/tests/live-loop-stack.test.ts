import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LiveLoopStack, LiveLoopStackNames, LiveLoopStackSeed } from '../live-loop-stack.js'
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

describe('LiveLoopStack.Redact', () =>
{
    it('replaces the stack passwords in any failure text', () =>
    {
        const out = new LiveLoopStack().Redact('login failed for ' + LiveLoopStackNames.OwnerPassword + ' and ' + LiveLoopStackNames.OperatorPassword)
        assert.equal(out, 'login failed for *** and ***')
    })
})
