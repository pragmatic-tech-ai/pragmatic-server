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

    public readonly Dir = mkdtempSync(join(tmpdir(), 'ps-admin-e2e-'))
    public Host!: PragmaticServerHost

    public static get Bob(): string
    {
        return AdminHostFixture.NewSubject
    }

    public async StartAsync(): Promise<void>
    {
        process.env[AdminHostFixture.KeyEnv] = randomBytes(32).toString('base64')
        const entries = new Map<string, TenantProvisioning>([[AdminHostFixture.TenantId, { displayName: 'Tenant One' }]])
        this.Host = await PragmaticServerHost.StartAsync({ host: '127.0.0.1', port: 0, baseDir: this.Dir, masterKey: { base64Env: AdminHostFixture.KeyEnv }, provisioning: new InMemoryTenantProvisioning(entries) })
    }

    public async ConnectAs(role: Role): Promise<MessageConnection>
    {
        const subject = role === Role.Owner ? AdminHostFixture.OwnerSubject : AdminHostFixture.ViewerSubject
        const pack = await this.Host.IdentityPackForTest(AdminHostFixture.TenantId)
        await pack.Grants.Save(new Grant(subject, role, new ResourceRef(ResourceKind.Tenant, AdminHostFixture.TenantId, [])))
        const issued = await pack.Tokens.Issue(await this.Host.TenantForTest(AdminHostFixture.TenantId), subject, [], null)
        const address = this.Host.Address()
        const ws = new WebSocket(`ws://${address.host}:${address.port}/?tenant=${AdminHostFixture.TenantId}`, { headers: { authorization: `Bearer ${issued.Token}` } })
        await new Promise<void>((resolve, reject) =>
        {
            ws.once('open', () => resolve())
            ws.once('error', reject)
        })
        const socket = new WsMessageSocket(ws)
        const connection = createMessageConnection(new WebSocketMessageReader(socket), new WebSocketMessageWriter(socket), NullLogger)
        connection.listen()
        return connection
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
        const ack = await client.sendRequest(AdminProtocol.GrantRole, { subject: AdminHostFixture.Bob, role: 'Editor' })
        assert.deepEqual(ack, { ok: true })
        const stored = await fx.BobGrants()
        assert.equal(stored.length, 1)
        assert.equal(stored[0].Role, Role.Editor)
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
        await assert.rejects(client.sendRequest(AdminProtocol.GrantRole, { subject: AdminHostFixture.Bob, role: 'Editor' }), (e: unknown) =>
            e instanceof ResponseError && e.code === ErrorCodes.InvalidRequest)
        assert.equal((await fx.BobGrants()).length, 0)
    }
    finally
    {
        client.dispose()
        await fx.DisposeAsync()
    }
})
