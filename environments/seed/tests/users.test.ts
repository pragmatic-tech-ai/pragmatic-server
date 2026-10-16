import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AdminProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import { UserSeeder } from '../users.js'

test('LoginBody and BearerHeader shape the auth request correctly', () =>
{
    assert.equal(UserSeeder.LoginBody('admin@contoso.test', 'pw'), JSON.stringify({ email: 'admin@contoso.test', password: 'pw' }))
    assert.deepEqual(UserSeeder.BearerHeader('tok'), { Authorization: 'Bearer tok' })
})

test('SeedUsers sends CreateAccount then GrantRole per user', async () =>
{
    const sent: { method: string; params: unknown }[] = []
    const fake = { sendRequest: async (type: { method: string }, params: unknown) => { sent.push({ method: type.method, params }); return { ok: true } } }
    await new UserSeeder().SeedUsers(fake as never, [{ principalId: 'rep-boston', email: 'rep-boston@contoso.test', passwordRef: 'rep-boston-pw', coarseRole: 'Editor', password: 'pw' } as never])
    assert.deepEqual(sent.map(s => s.method), [AdminProtocol.CreateAccount.method, AdminProtocol.GrantRole.method])
    assert.deepEqual(sent[0].params, { email: 'rep-boston@contoso.test', principalId: 'rep-boston', password: 'pw' })
    assert.deepEqual(sent[1].params, { subject: 'rep-boston', role: 'Editor', resourceKind: 'Tenant', resourcePath: [] })
})

test('SeedUsers swallows account-already-exists and still grants', async () =>
{
    const methods: string[] = []
    const fake = { sendRequest: async (type: { method: string }) =>
    {
        methods.push(type.method)
        if (type.method === AdminProtocol.CreateAccount.method)
        {
            throw new Error('account already exists')
        }
        return { ok: true }
    } }
    await new UserSeeder().SeedUsers(fake as never, [{ principalId: 'p', email: 'p@x.test', passwordRef: 'r', coarseRole: 'Viewer', password: 'pw' }])
    assert.deepEqual(methods, [AdminProtocol.CreateAccount.method, AdminProtocol.GrantRole.method])
})
