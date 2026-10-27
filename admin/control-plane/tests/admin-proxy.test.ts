import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdminProxy, AdminProxyError, AdminProxyErrorKind } from '../admin-proxy.js'
import type { AdminConnectInfo, IAdminConnection, IAdminConnector } from '../admin-proxy.js'

class FakeConnection implements IAdminConnection
{
    public readonly Calls: string[] = []
    public Disposed = 0
    public FailWith: Error | undefined

    private Record(name: string): void
    {
        this.Calls.push(name)
        if (this.FailWith !== undefined)
        {
            throw this.FailWith
        }
    }

    public async ListAccounts(): Promise<any[]>
    {
        this.Record('ListAccounts')
        return [{ principalId: 'a' }, { principalId: 'b' }]
    }

    public async CreateAccount(_params: any): Promise<void>
    {
        this.Record('CreateAccount')
    }

    public async DisableAccount(principalId: string): Promise<void>
    {
        this.Record('DisableAccount:' + principalId)
    }

    public async ListGrants(subject: string): Promise<any[]>
    {
        this.Record('ListGrants:' + subject)
        return [{ subject, role: 'r' }]
    }

    public async GrantRole(_m: any): Promise<void>
    {
        this.Record('GrantRole')
    }

    public async RevokeRole(_m: any): Promise<void>
    {
        this.Record('RevokeRole')
    }

    public async GetConfig(): Promise<any>
    {
        this.Record('GetConfig')
        return { mode: 'x' }
    }

    public async SetConfig(_c: any): Promise<void>
    {
        this.Record('SetConfig')
    }

    public async GetSecurityModel(): Promise<any>
    {
        this.Record('GetSecurityModel')
        return { roles: [] }
    }

    public async SetSecurityModel(_m: any): Promise<void>
    {
        this.Record('SetSecurityModel')
    }

    public async CreateGraph(_p: any): Promise<any>
    {
        this.Record('CreateGraph')
        return {}
    }

    public async ListGraphs(): Promise<any[]>
    {
        this.Record('ListGraphs')
        return []
    }

    public async GetGraph(_p: any): Promise<any>
    {
        this.Record('GetGraph')
        return {}
    }

    public async DeleteGraph(_p: any): Promise<void>
    {
        this.Record('DeleteGraph')
    }

    public async ExportGraph(_p: any): Promise<any>
    {
        this.Record('ExportGraph')
        return { name: 'g', packages: [] }
    }

    public async LoadGraph(_p: any): Promise<any>
    {
        this.Record('LoadGraph')
        return { name: 'g', packages: [], promotedAt: '2026-10-20T00:00:00.000Z' }
    }

    public async GetLoadedGraph(): Promise<any>
    {
        this.Record('GetLoadedGraph')
        return null
    }

    public async IssueToken(_p: any): Promise<any>
    {
        this.Record('IssueToken')
        return { token: 'tok', principalId: 'maker' }
    }

    public async ListTokens(): Promise<any>
    {
        this.Record('ListTokens')
        return [{ tokenId: 't1', principalId: 'maker' }]
    }

    public async RevokeToken(_p: any): Promise<any>
    {
        this.Record('RevokeToken')
        return { ok: true }
    }

    public Dispose(): void
    {
        this.Disposed++
    }
}

class FakeConnector implements IAdminConnector
{
    public Opens = 0

    public constructor(public readonly Conn: FakeConnection, private readonly failOpen?: Error)
    {
    }

    public async Open(_info: AdminConnectInfo): Promise<IAdminConnection>
    {
        this.Opens++
        if (this.failOpen !== undefined)
        {
            throw this.failOpen
        }
        return this.Conn
    }
}

class Fixtures
{
    public static readonly Info: AdminConnectInfo = { httpUrl: 'http://h', wsUrl: 'ws://h', tenant: 't', email: 'e', password: 'p' }
}

describe('AdminProxy', () =>
{
    it('LoadAdmin uses one connection and disposes once', async () =>
    {
        const conn = new FakeConnection()
        const connector = new FakeConnector(conn)
        const snap = await new AdminProxy(connector).LoadAdmin(Fixtures.Info)
        assert.equal(connector.Opens, 1)
        assert.equal(conn.Disposed, 1)
        assert.deepEqual(conn.Calls, ['ListAccounts', 'ListGrants:a', 'ListGrants:b', 'GetConfig'])
        assert.equal(snap.accounts.length, 2)
        assert.equal(snap.grants.length, 2)
        assert.deepEqual(snap.config, { mode: 'x' })
    })

    it('each mutation opens, calls and disposes once', async () =>
    {
        const cases: Array<[string, (p: AdminProxy) => Promise<void>]> = [
            ['CreateAccount', p => p.CreateAccount(Fixtures.Info, {} as any)],
            ['DisableAccount:a', p => p.DisableAccount(Fixtures.Info, 'a')],
            ['GrantRole', p => p.GrantRole(Fixtures.Info, {} as any)],
            ['RevokeRole', p => p.RevokeRole(Fixtures.Info, {} as any)],
            ['SetConfig', p => p.SetConfig(Fixtures.Info, {} as any)],
            ['SetSecurityModel', p => p.SetSecurityModel(Fixtures.Info, {} as any)],
            ['CreateGraph', async p => { await p.CreateGraph(Fixtures.Info, {} as any) }],
            ['ListGraphs', async p => { await p.ListGraphs(Fixtures.Info) }],
            ['GetGraph', async p => { await p.GetGraph(Fixtures.Info, {} as any) }],
            ['DeleteGraph', p => p.DeleteGraph(Fixtures.Info, {} as any)],
            ['IssueToken', async p => { await p.IssueToken(Fixtures.Info, {} as any) }],
            ['ListTokens', async p => { await p.ListTokens(Fixtures.Info) }],
            ['RevokeToken', async p => { await p.RevokeToken(Fixtures.Info, {} as any) }],
        ]
        for (const [call, run] of cases)
        {
            const conn = new FakeConnection()
            const connector = new FakeConnector(conn)
            await run(new AdminProxy(connector))
            assert.equal(connector.Opens, 1)
            assert.equal(conn.Disposed, 1)
            assert.deepEqual(conn.Calls, [call])
        }
    })

    it('GetConfig returns the connection config', async () =>
    {
        const conn = new FakeConnection()
        assert.deepEqual(await new AdminProxy(new FakeConnector(conn)).GetConfig(Fixtures.Info), { mode: 'x' })
        assert.equal(conn.Disposed, 1)
    })

    it('GetSecurityModel returns the connection security model', async () =>
    {
        const conn = new FakeConnection()
        assert.deepEqual(await new AdminProxy(new FakeConnector(conn)).GetSecurityModel(Fixtures.Info), { roles: [] })
        assert.deepEqual(conn.Calls, ['GetSecurityModel'])
        assert.equal(conn.Disposed, 1)
    })

    it('maps an Open rejection to Connect', async () =>
    {
        const proxy = new AdminProxy(new FakeConnector(new FakeConnection(), new Error('ECONNREFUSED')))
        await assert.rejects(proxy.GetConfig(Fixtures.Info), (e: unknown) => e instanceof AdminProxyError && e.Kind === AdminProxyErrorKind.Connect)
    })

    it('classifies by message', async () =>
    {
        const cases: Array<[string, AdminProxyErrorKind]> = [
            ['cannot revoke the tenant\'s last administrator', AdminProxyErrorKind.Rbac],
            ['cannot revoke your own tenant-Owner grant', AdminProxyErrorKind.Rbac],
            ['invalid params: bad email', AdminProxyErrorKind.Invalid],
            ['boom', AdminProxyErrorKind.Protocol],
            ['service token not found: t9', AdminProxyErrorKind.NotFound],
            ['Service Token Not Found', AdminProxyErrorKind.NotFound],
        ]
        for (const [message, kind] of cases)
        {
            const conn = new FakeConnection()
            conn.FailWith = new Error(message)
            await assert.rejects(new AdminProxy(new FakeConnector(conn)).RevokeRole(Fixtures.Info, {} as any), (e: unknown) =>
                e instanceof AdminProxyError && e.Kind === kind && e.message.includes(message))
        }
    })

    it('IssueToken returns the issued token dto and classifies errors', async () =>
    {
        const conn = new FakeConnection()
        const got = await new AdminProxy(new FakeConnector(conn)).IssueToken(Fixtures.Info, { principalId: 'maker', scopes: [], expiresInSeconds: 60 })
        assert.deepEqual(got, { token: 'tok', principalId: 'maker' })
        assert.equal(conn.Disposed, 1)
        const bad = new FakeConnection()
        bad.FailWith = new Error('invalid params: nope')
        await assert.rejects(new AdminProxy(new FakeConnector(bad)).IssueToken(Fixtures.Info, {} as any), (e: unknown) =>
            e instanceof AdminProxyError && e.Kind === AdminProxyErrorKind.Invalid)
        assert.equal(bad.Disposed, 1)
    })

    it('ListTokens and RevokeToken return the connection results', async () =>
    {
        const conn = new FakeConnection()
        const proxy = new AdminProxy(new FakeConnector(conn))
        assert.deepEqual(await proxy.ListTokens(Fixtures.Info), [{ tokenId: 't1', principalId: 'maker' }])
        assert.deepEqual(await proxy.RevokeToken(Fixtures.Info, { tokenId: 't1' } as any), { ok: true })
        assert.equal(conn.Disposed, 2)
    })

    it('disposes in finally when a method throws', async () =>
    {
        const conn = new FakeConnection()
        conn.FailWith = new Error('boom')
        await assert.rejects(new AdminProxy(new FakeConnector(conn)).LoadAdmin(Fixtures.Info))
        assert.equal(conn.Disposed, 1)
    })
})
