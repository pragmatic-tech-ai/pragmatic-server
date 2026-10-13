import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RedisClientType } from 'redis'
import { OidcFlowState } from '@pragmatic-tech-ai/todl-identity-cloud'
import { RedisOidcFlowStateStore } from '../redis-oidc-flow-state-store.js'

class Fixture
{
    public static readonly Prefix = 'pragmatic:oidc:t1:'
    public static readonly OtherPrefix = 'pragmatic:oidc:t2:'
    public static readonly Url = 'redis://unused'
    public static readonly LiveSkip = 'set PRAGMATIC_TEST_REDIS_URL to run'
    public static readonly Now = new Date('2026-01-01T00:00:00.000Z')

    public static State(raw: string): OidcFlowState
    {
        return new OidcFlowState(raw, 'nonce-1', 'verifier-1', 'https://app/cb', new Date(Fixture.Now.getTime() + 60_000))
    }
}

class FakeRedis
{
    public isOpen = false
    public setCalls: Array<{ key: string, value: string, options: { PX: number, NX: boolean } }> = []
    public getDelResult: string | null = null
    public getDelThrows = false
    public setThrows = false
    public getDelKeys: string[] = []

    public on(): this
    {
        return this
    }

    public async connect(): Promise<void>
    {
        this.isOpen = true
    }

    public async set(key: string, value: string, options: { PX: number, NX: boolean }): Promise<string>
    {
        if (this.setThrows)
        {
            throw new Error('boom redis://secret')
        }
        this.setCalls.push({ key, value, options })
        return 'OK'
    }

    public async quit(): Promise<void>
    {
        this.isOpen = false
    }

    public async getDel(key: string): Promise<string | null>
    {
        this.getDelKeys.push(key)
        if (this.getDelThrows)
        {
            throw new Error('boom redis://secret')
        }
        return this.getDelResult
    }

    public AsClient(): RedisClientType
    {
        return this as unknown as RedisClientType
    }
}

test('redis oidc flow store: Put writes a namespaced NX/PX key with the JSON payload', async () =>
{
    const fake = new FakeRedis()
    const store = new RedisOidcFlowStateStore(Fixture.Url, Fixture.Prefix, () => Fixture.Now, () => fake.AsClient())
    const state = Fixture.State('s1')
    await store.Put(state)
    assert.equal(fake.setCalls.length, 1)
    const call = fake.setCalls[0]
    assert.equal(call.key, Fixture.Prefix + 's1')
    assert.equal(call.options.NX, true)
    assert.equal(call.options.PX, 60_000)
    const p = JSON.parse(call.value)
    assert.equal(p.State, 's1')
    assert.equal(p.Nonce, 'nonce-1')
    assert.equal(p.CodeVerifier, 'verifier-1')
    assert.equal(p.RedirectUri, 'https://app/cb')
    assert.equal(p.ExpiresAt, state.ExpiresAt.toISOString())
})

test('redis oidc flow store: Take returns the stored state, null when absent', async () =>
{
    const fake = new FakeRedis()
    const store = new RedisOidcFlowStateStore(Fixture.Url, Fixture.Prefix, () => Fixture.Now, () => fake.AsClient())
    await store.Put(Fixture.State('s1'))
    fake.getDelResult = fake.setCalls[0].value
    const got = await store.Take('s1')
    assert.deepEqual(fake.getDelKeys, [Fixture.Prefix + 's1'])
    assert.ok(got !== null)
    assert.equal(got.State, 's1')
    assert.equal(got.Nonce, 'nonce-1')
    assert.equal(got.CodeVerifier, 'verifier-1')
    assert.equal(got.RedirectUri, 'https://app/cb')
    assert.equal(got.ExpiresAt.getTime(), Fixture.Now.getTime() + 60_000)
    fake.getDelResult = null
    assert.equal(await store.Take('s1'), null)
})

test('redis oidc flow store: Take returns null for an expired entry', async () =>
{
    const fake = new FakeRedis()
    let clock = Fixture.Now
    const store = new RedisOidcFlowStateStore(Fixture.Url, Fixture.Prefix, () => clock, () => fake.AsClient())
    await store.Put(Fixture.State('s1'))
    fake.getDelResult = fake.setCalls[0].value
    clock = new Date(Fixture.Now.getTime() + 120_000)
    assert.equal(await store.Take('s1'), null)
})

test('redis oidc flow store: fail-closed, Take returns null on a Redis error', async () =>
{
    const fake = new FakeRedis()
    fake.getDelThrows = true
    const store = new RedisOidcFlowStateStore(Fixture.Url, Fixture.Prefix, () => Fixture.Now, () => fake.AsClient())
    assert.equal(await store.Take('s1'), null)
})

test('redis oidc flow store: fail-closed, Put rethrows a sanitized error', async () =>
{
    const fake = new FakeRedis()
    fake.setThrows = true
    const store = new RedisOidcFlowStateStore(Fixture.Url, Fixture.Prefix, () => Fixture.Now, () => fake.AsClient())
    await assert.rejects(() => store.Put(Fixture.State('s1')), (e: Error) => e.message === RedisOidcFlowStateStore.PutFailedText && !e.message.includes(Fixture.Url) && !e.message.includes('nonce-1'))
})

test('redis oidc flow store: Put of an already-expired state uses the default TTL', async () =>
{
    const fake = new FakeRedis()
    const store = new RedisOidcFlowStateStore(Fixture.Url, Fixture.Prefix, () => new Date(Fixture.Now.getTime() + 120_000), () => fake.AsClient())
    await store.Put(Fixture.State('s1'))
    assert.equal(fake.setCalls[0].options.PX, RedisOidcFlowStateStore.DefaultTtlMs)
})

test('redis oidc flow store: a second Put of the same key is still issued with NX', async () =>
{
    const fake = new FakeRedis()
    const store = new RedisOidcFlowStateStore(Fixture.Url, Fixture.Prefix, () => Fixture.Now, () => fake.AsClient())
    await store.Put(Fixture.State('s1'))
    await store.Put(Fixture.State('s1'))
    assert.equal(fake.setCalls.length, 2)
    assert.equal(fake.setCalls[1].options.NX, true)
})

test('redis oidc flow store: Take rejects an entry whose State does not match the key', async () =>
{
    const fake = new FakeRedis()
    const store = new RedisOidcFlowStateStore(Fixture.Url, Fixture.Prefix, () => Fixture.Now, () => fake.AsClient())
    await store.Put(Fixture.State('other'))
    fake.getDelResult = fake.setCalls[0].value
    assert.equal(await store.Take('s1'), null)
})

test('redis oidc flow store: Dispose quits an opened client and is a no-op when never connected', async () =>
{
    const fake = new FakeRedis()
    const store = new RedisOidcFlowStateStore(Fixture.Url, Fixture.Prefix, () => Fixture.Now, () => fake.AsClient())
    await store.Dispose()
    await store.Put(Fixture.State('s1'))
    assert.equal(fake.isOpen, true)
    await store.Dispose()
    assert.equal(fake.isOpen, false)
})

const url = process.env.PRAGMATIC_TEST_REDIS_URL

test('redis oidc flow store (live): cross-instance, single-use, namespace-isolated', { skip: url === undefined ? Fixture.LiveSkip : false }, async () =>
{
    const raw = `s-${Date.now()}`
    const a = new RedisOidcFlowStateStore(url as string, Fixture.Prefix)
    const b = new RedisOidcFlowStateStore(url as string, Fixture.Prefix)
    const other = new RedisOidcFlowStateStore(url as string, Fixture.OtherPrefix)
    const state = new OidcFlowState(raw, 'n', 'v', 'https://app/cb', new Date(Date.now() + 60_000))
    try
    {
        await a.Put(state)
        assert.equal(await other.Take(raw), null)
        const got = await b.Take(raw)
        assert.ok(got !== null)
        assert.equal(got.Nonce, 'n')
        assert.equal(got.CodeVerifier, 'v')
        assert.equal(await b.Take(raw), null)
        assert.equal(await a.Take(raw), null)
    }
    finally
    {
        await a.Dispose()
        await b.Dispose()
        await other.Dispose()
    }
})
