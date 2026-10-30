import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Grant, Role, ResourceRef, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import { WebSocket } from 'ws'
import { AdminProtocol, WsMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, ResponseError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PragmaticServerHost } from '../pragmatic-server-host.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'

class AdminHostFixture
{
    private static readonly KeyEnv = 'PS_ADMIN_E2E_KEY'
    private static readonly TenantId = 't1'
    private static readonly OwnerSubject = 'owner1'
    private static readonly ViewerSubject = 'viewer1'
    private static readonly NewSubject = 'bob'
    private static readonly TenantDisplayName = 'Tenant One'
    public static readonly RoleEditorName = 'Editor'
    public static readonly RoleViewerName = 'Viewer'
    public static readonly AccountEmail = 'dave@example.com'
    public static readonly AccountPrincipal = 'dave'
    public static readonly AccountPassword = 'e2e-pass-phrase-123'
    private static readonly WsOpenEvent = 'open'
    private static readonly WsErrorEvent = 'error'
    private static readonly WsCloseEvent = 'close'
    private static readonly NotClosedMessage = 'socket did not close in time'
    public static readonly CloseTimeoutMs = 2000
    public static readonly StayOpenMs = 400

    public readonly Dir = mkdtempSync(join(tmpdir(), 'ps-admin-e2e-'))
    public Host!: PragmaticServerHost

    public static get Bob(): string
    {
        return AdminHostFixture.NewSubject
    }

    public async StartAsync(): Promise<void>
    {
        process.env[AdminHostFixture.KeyEnv] = randomBytes(32).toString('base64')
        const entries = new Map<string, TenantProvisioning>([[AdminHostFixture.TenantId, { displayName: AdminHostFixture.TenantDisplayName }]])
        this.Host = await PragmaticServerHost.StartAsync({ host: '127.0.0.1', port: 0, baseDir: this.Dir, masterKey: { base64Env: AdminHostFixture.KeyEnv }, provisioning: new InMemoryTenantProvisioning(entries) })
    }

    public async ConnectAs(role: Role): Promise<MessageConnection>
    {
        return (await this.ConnectAsWithSocket(role)).connection
    }

    public async ConnectAsWithSocket(role: Role): Promise<{ connection: MessageConnection, ws: WebSocket }>
    {
        const subject = role === Role.Owner ? AdminHostFixture.OwnerSubject : AdminHostFixture.ViewerSubject
        const pack = await this.Host.IdentityPackForTest(AdminHostFixture.TenantId)
        await pack.Grants.Save(new Grant(subject, role, new ResourceRef(ResourceKind.Tenant, AdminHostFixture.TenantId, [])))
        const issued = await pack.Tokens.Issue(await this.Host.TenantForTest(AdminHostFixture.TenantId), subject, [], null)
        const address = this.Host.Address()
        const ws = new WebSocket(`ws://${address.host}:${address.port}/?environment=${AdminHostFixture.TenantId}`, { headers: { authorization: `Bearer ${issued.Token}` } })
        await new Promise<void>((resolve, reject) =>
        {
            ws.once(AdminHostFixture.WsOpenEvent, () => resolve())
            ws.once(AdminHostFixture.WsErrorEvent, reject)
        })
        const socket = new WsMessageSocket(ws)
        const connection = createMessageConnection(new WebSocketMessageReader(socket), new WebSocketMessageWriter(socket), NullLogger)
        connection.listen()
        return { connection, ws }
    }

    public static ClosedWithin(ws: WebSocket, ms: number): Promise<void>
    {
        return new Promise<void>((resolve, reject) =>
        {
            if (ws.readyState === WebSocket.CLOSED)
            {
                resolve()
                return
            }
            const timer = setTimeout(() => reject(new Error(AdminHostFixture.NotClosedMessage)), ms)
            ws.once(AdminHostFixture.WsCloseEvent, () =>
            {
                clearTimeout(timer)
                resolve()
            })
        })
    }

    public static async StaysOpen(ws: WebSocket, ms: number): Promise<boolean>
    {
        return AdminHostFixture.ClosedWithin(ws, ms).then(() => false, () => true)
    }

    public static get ViewerName(): string
    {
        return AdminHostFixture.ViewerSubject
    }

    public async BobGrants(): Promise<readonly Grant[]>
    {
        const pack = await this.Host.IdentityPackForTest(AdminHostFixture.TenantId)
        return pack.Grants.GrantsFor(AdminHostFixture.NewSubject, await this.Host.TenantForTest(AdminHostFixture.TenantId))
    }

    public async DisposeAsync(): Promise<void>
    {
        await this.Host.DisposeAsync()
        rmSync(this.Dir, { recursive: true, force: true })
        delete process.env[AdminHostFixture.KeyEnv]
    }
}

test('an Owner over a live host connection grants a role that persists to the pack', async () =>
{
    const fx = new AdminHostFixture()
    await fx.StartAsync()
    const client = await fx.ConnectAs(Role.Owner)
    try
    {
        const ack = await client.sendRequest(AdminProtocol.GrantRole, { subject: AdminHostFixture.Bob, role: AdminHostFixture.RoleEditorName })
        assert.deepEqual(ack, { ok: true })
        const stored = await fx.BobGrants()
        assert.equal(stored.length, 1)
        assert.equal(stored[0]!.Role, Role.Editor)
    }
    finally
    {
        client.dispose()
        await fx.DisposeAsync()
    }
})

test('a Viewer over a live host connection is denied admin/* and nothing persists', async () =>
{
    const fx = new AdminHostFixture()
    await fx.StartAsync()
    const client = await fx.ConnectAs(Role.Viewer)
    try
    {
        await assert.rejects(client.sendRequest(AdminProtocol.GrantRole, { subject: AdminHostFixture.Bob, role: AdminHostFixture.RoleEditorName }), (e: unknown) =>
            e instanceof ResponseError && e.code === ErrorCodes.InvalidRequest)
        assert.equal((await fx.BobGrants()).length, 0)
    }
    finally
    {
        client.dispose()
        await fx.DisposeAsync()
    }
})

test('an Owner creates, lists and disables a local account over a live connection', async () =>
{
    const fx = new AdminHostFixture()
    await fx.StartAsync()
    const client = await fx.ConnectAs(Role.Owner)
    try
    {
        await client.sendRequest(AdminProtocol.CreateAccount, { email: AdminHostFixture.AccountEmail, principalId: AdminHostFixture.AccountPrincipal, password: AdminHostFixture.AccountPassword })
        const created = (await client.sendRequest(AdminProtocol.ListAccounts)).find(a => a.principalId === AdminHostFixture.AccountPrincipal)
        assert.deepEqual(created, { principalId: AdminHostFixture.AccountPrincipal, email: AdminHostFixture.AccountEmail, disabled: false })
        await client.sendRequest(AdminProtocol.DisableAccount, { principalId: AdminHostFixture.AccountPrincipal })
        const disabled = (await client.sendRequest(AdminProtocol.ListAccounts)).find(a => a.principalId === AdminHostFixture.AccountPrincipal)
        assert.equal(disabled?.disabled, true)
    }
    finally
    {
        client.dispose()
        await fx.DisposeAsync()
    }
})

test('an Owner issues, lists and revokes a service token over a live connection', async () =>
{
    const fx = new AdminHostFixture()
    await fx.StartAsync()
    const client = await fx.ConnectAs(Role.Owner)
    try
    {
        // service tokens are account-independent: no local account is needed for this principal.
        const issued = await client.sendRequest(AdminProtocol.IssueToken, { principalId: AdminHostFixture.AccountPrincipal, scopes: [], expiresInSeconds: null })
        assert.ok(issued.token.length > 0)
        const listed = (await client.sendRequest(AdminProtocol.ListTokens)).find(t => t.tokenRef === issued.tokenRef)
        assert.equal(listed?.revoked, false)
        assert.equal(JSON.stringify(listed).includes(issued.token), false)
        await client.sendRequest(AdminProtocol.RevokeToken, { tokenRef: issued.tokenRef })
        const revoked = (await client.sendRequest(AdminProtocol.ListTokens)).find(t => t.tokenRef === issued.tokenRef)
        assert.equal(revoked?.revoked, true)
    }
    finally
    {
        client.dispose()
        await fx.DisposeAsync()
    }
})

test('a Viewer over a live host connection is denied the account and token methods', async () =>
{
    const fx = new AdminHostFixture()
    await fx.StartAsync()
    const client = await fx.ConnectAs(Role.Viewer)
    try
    {
        await assert.rejects(client.sendRequest(AdminProtocol.ListAccounts), (e: unknown) =>
            e instanceof ResponseError && e.code === ErrorCodes.InvalidRequest)
        await assert.rejects(client.sendRequest(AdminProtocol.IssueToken, { principalId: AdminHostFixture.AccountPrincipal, scopes: [], expiresInSeconds: null }), (e: unknown) =>
            e instanceof ResponseError && e.code === ErrorCodes.InvalidRequest)
    }
    finally
    {
        client.dispose()
        await fx.DisposeAsync()
    }
})

test('revoking a connected principal role force-closes its live connection', async () =>
{
    const fx = new AdminHostFixture()
    await fx.StartAsync()
    const owner = await fx.ConnectAs(Role.Owner)
    const viewer = await fx.ConnectAsWithSocket(Role.Viewer)
    try
    {
        await owner.sendRequest(AdminProtocol.RevokeRole, { subject: AdminHostFixture.ViewerName, role: AdminHostFixture.RoleViewerName })
        await AdminHostFixture.ClosedWithin(viewer.ws, AdminHostFixture.CloseTimeoutMs)
    }
    finally
    {
        viewer.connection.dispose()
        owner.dispose()
        await fx.DisposeAsync()
    }
})

test('revoking one principal leaves another principal connection usable', async () =>
{
    const fx = new AdminHostFixture()
    await fx.StartAsync()
    const ownerSide = await fx.ConnectAsWithSocket(Role.Owner)
    const viewer = await fx.ConnectAsWithSocket(Role.Viewer)
    try
    {
        await ownerSide.connection.sendRequest(AdminProtocol.RevokeRole, { subject: AdminHostFixture.ViewerName, role: AdminHostFixture.RoleViewerName })
        await AdminHostFixture.ClosedWithin(viewer.ws, AdminHostFixture.CloseTimeoutMs)
        assert.equal(await AdminHostFixture.StaysOpen(ownerSide.ws, AdminHostFixture.StayOpenMs), true)
        assert.ok(Array.isArray(await ownerSide.connection.sendRequest(AdminProtocol.ListAccounts)))
    }
    finally
    {
        viewer.connection.dispose()
        ownerSide.connection.dispose()
        await fx.DisposeAsync()
    }
})

test('disabling an account force-closes that principal live connection', async () =>
{
    const fx = new AdminHostFixture()
    await fx.StartAsync()
    const owner = await fx.ConnectAs(Role.Owner)
    const viewer = await fx.ConnectAsWithSocket(Role.Viewer)
    try
    {
        await owner.sendRequest(AdminProtocol.CreateAccount, { email: AdminHostFixture.AccountEmail, principalId: AdminHostFixture.ViewerName, password: AdminHostFixture.AccountPassword })
        await owner.sendRequest(AdminProtocol.DisableAccount, { principalId: AdminHostFixture.ViewerName })
        await AdminHostFixture.ClosedWithin(viewer.ws, AdminHostFixture.CloseTimeoutMs)
    }
    finally
    {
        viewer.connection.dispose()
        owner.dispose()
        await fx.DisposeAsync()
    }
})
