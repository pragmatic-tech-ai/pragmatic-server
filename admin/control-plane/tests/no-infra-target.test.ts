import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ClientRegistry } from '../client-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { UnsupportedBackendError } from '../hive-orchestrator.js'
import { IdpAdminClient } from '../idp-admin-client.js'
import { IdpRegistry } from '../idp-registry.js'
import { IdpService } from '../idp-service.js'
import { NoInfraTarget, NoInfraTargetBackendError, NoInfraTargetError, NoTargetEnvironmentRuntime, NoTargetHiveOrchestratorFactory, NoTargetIdpDriver, NoTargetImageDigest } from '../no-infra-target.js'
import { ControlPlaneServer } from '../server.js'
import { PlatformDirectory } from '../platform-directory.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'
import { TenantProvisioningService } from '../tenant-provisioning-service.js'
import { TenantRegistry } from '../tenant-registry.js'
import type { EnvRuntimeContext } from '../environment-runtime.js'
import type { IdpRecord } from '../idp-record.js'

class NoTargetFixture
{
    public static readonly Message = 'no Docker/cluster target configured'

    public static Hive(backend: HiveBackend, mode: InfraMode): HiveRecord
    {
        return { id: 'h1', tenantId: 't1', displayName: 'H', cluster: { backend, mode }, registry: { mode: InfraMode.Provision } } as HiveRecord
    }

    public static Context(): EnvRuntimeContext
    {
        return { record: { name: 'env1' } } as unknown as EnvRuntimeContext
    }
}

describe('No infrastructure target (D28 interim)', () =>
{
    let root: string

    beforeEach(() =>
    {
        root = mkdtempSync(join(tmpdir(), 'no-infra-target-'))
    })

    afterEach(() => rmSync(root, { recursive: true, force: true }))

    it('the shared message is the plain sentence', () =>
    {
        assert.equal(NoInfraTarget.Message, NoTargetFixture.Message)
        assert.equal(new NoInfraTargetError().message, NoTargetFixture.Message)
    })

    it('the orchestrator factory refuses every hive with an UnsupportedBackendError carrying the message', () =>
    {
        const factory = new NoTargetHiveOrchestratorFactory()
        for (const hive of [NoTargetFixture.Hive(HiveBackend.Local, InfraMode.Attach), NoTargetFixture.Hive(HiveBackend.Local, InfraMode.Provision), NoTargetFixture.Hive(HiveBackend.Gke, InfraMode.Attach)])
        {
            assert.throws(() => factory.For(hive), (e: Error) =>
            {
                assert.ok(e instanceof NoInfraTargetBackendError)
                assert.ok(e instanceof UnsupportedBackendError, 'rollout push and cluster destroy treat it as unsupported (a no-op)')
                assert.equal(e.message, NoTargetFixture.Message)
                return true
            })
        }
    })

    it('the IdP driver refuses to launch and discards nothing', async () =>
    {
        const driver = new NoTargetIdpDriver()
        await assert.rejects(driver.EnsureRunning({ tenantId: 't1', displayName: 'T', takenPorts: [] } as unknown as Parameters<NoTargetIdpDriver['EnsureRunning']>[0]), NoInfraTargetError)
        await driver.Discard({} as IdpRecord)
    })

    it('the environment runtime reports nothing running, lets stop pass, and refuses to start with the message', async () =>
    {
        const runtime = new NoTargetEnvironmentRuntime()
        assert.equal(await runtime.Running('pragmatic-env-x'), false)
        assert.equal(await runtime.Probe(NoTargetFixture.Context()), false)
        await runtime.Stop(NoTargetFixture.Context())
        await assert.rejects(runtime.Start(NoTargetFixture.Context()), (e: Error) => e instanceof NoInfraTargetError && e.message === NoTargetFixture.Message)
        assert.throws(() => runtime.BuildCommand(), NoInfraTargetError)
    })

    it('the image digest refuses, so no signer or verifier ever spawns docker', async () =>
    {
        await assert.rejects(new NoTargetImageDigest().Of('img:1'), NoInfraTargetError)
        const signer = ControlPlaneServer.ImageSignerOf(root, undefined, new NoTargetImageDigest())
        await assert.rejects(signer.Sign('img:1', 'platform-release'), NoInfraTargetError)
    })

    it('creating a tenant fails with the message and leaves no tenant and no IdP record behind', async () =>
    {
        const directory = new PlatformDirectory(new ClientRegistry(join(root, 'clients.json')), new TenantRegistry(join(root, 'tenants.json')),
            new HiveRegistry(join(root, 'hives.json')), { List: () => [] })
        await directory.Load()
        await directory.CreateClient({ id: 'acme', displayName: 'Acme' })
        const idps = new IdpRegistry(join(root, 'idps.json'))
        const provisioning = new TenantProvisioningService(new IdpService(idps, new NoTargetIdpDriver()), directory, c => new IdpAdminClient(c))
        await assert.rejects(provisioning.Provision({ id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' }), NoInfraTargetError)
        assert.equal(directory.GetTenant('t1'), undefined)
    })
})
