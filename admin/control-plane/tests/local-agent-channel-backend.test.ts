import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { AgentChannelOperation } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { LocalAgentChannelBackend } from '../local-agent-channel-backend.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { RolloutFixture } from './rollout-fixture.js'

class BackendFixture
{
    public static readonly HiveId = 'local1'
    public static readonly Unauthorized = { error: 'Unauthorized' }
}

describe('LocalAgentChannelBackend', () =>
{
    let parent: string
    let deployments: PlatformDeploymentRegistry
    let token: string
    let backend: LocalAgentChannelBackend

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'agent-backend-'))
        const directory = new PlatformDirectory(new ClientRegistry(join(parent, 'clients.json')), new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')), { List: () => [] })
        await directory.Load()
        await directory.CreateClient({ id: 'acme', displayName: 'Acme' })
        await directory.CreateTenant({ id: 't1', clientId: 'acme', displayName: 'T' })
        await directory.CreateHive({ id: BackendFixture.HiveId, tenantId: 't1', displayName: 'L', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        deployments = await RolloutFixture.Create(parent, directory, new HiveOrchestratorFactory())
        token = await deployments.RegisterHive(BackendFixture.HiveId)
        backend = new LocalAgentChannelBackend(deployments)
    })

    afterEach(() => rmSync(parent, { recursive: true, force: true }))

    it('answers 401 for an unknown hive and for a wrong token, without the token in the body', async () =>
    {
        for (const request of [
            { Operation: AgentChannelOperation.Target, HiveId: 'ghost', Token: token },
            { Operation: AgentChannelOperation.Target, HiveId: BackendFixture.HiveId, Token: 'wrong' }])
        {
            const reply = await backend.Handle(request)
            assert.equal(reply.Status, 401)
            assert.deepEqual(reply.Body, BackendFixture.Unauthorized)
        }
    })

    it('answers 404 for a target with no selection, then the selected target', async () =>
    {
        assert.deepEqual(await backend.Handle({ Operation: AgentChannelOperation.Target, HiveId: BackendFixture.HiveId, Token: token }), { Status: 404, Body: { error: 'Not found' } })
        await deployments.Publish('1.0.0', 'img:1')
        await deployments.Gate('t1', '1.0.0')
        await deployments.SelectTarget(BackendFixture.HiveId, '1.0.0')
        assert.deepEqual(await backend.Handle({ Operation: AgentChannelOperation.Target, HiveId: BackendFixture.HiveId, Token: token }), { Status: 200, Body: { version: '1.0.0', image: 'img:1' } })
    })

    it('refuses an adopt the policy forbids with the fixed 403 text, and a malformed body with 400', async () =>
    {
        await deployments.Publish('2.0.0', 'img:2')
        assert.deepEqual(await backend.Handle({ Operation: AgentChannelOperation.Adopt, HiveId: BackendFixture.HiveId, Token: token, Body: JSON.stringify({ version: '2.0.0' }) }),
            { Status: 403, Body: { error: 'Version is not adoptable for this hive' } })
        assert.equal((await backend.Handle({ Operation: AgentChannelOperation.Adopt, HiveId: BackendFixture.HiveId, Token: token, Body: '{not json' })).Status, 400)
    })

    it('records a snapshot with 204 and no body', async () =>
    {
        const body = JSON.stringify({ environments: [{ environmentName: 'prod', ready: true, detail: 'ok' }] })
        assert.deepEqual(await backend.Handle({ Operation: AgentChannelOperation.Snapshot, HiveId: BackendFixture.HiveId, Token: token, Body: body }), { Status: 204 })
    })

    it('clamps the ledger limit to 200', async () =>
    {
        const reply = await backend.Handle({ Operation: AgentChannelOperation.Ledger, HiveId: BackendFixture.HiveId, Token: token, Query: { limit: '500' } })
        assert.equal(reply.Status, 200)
        assert.ok(Array.isArray(reply.Body) && (reply.Body as unknown[]).length <= 200)
    })

    it('does not serve the console without an advert receiver', () =>
    {
        assert.equal(backend.ServesConsole(), false)
    })
})
