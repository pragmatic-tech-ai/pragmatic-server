import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OciRegistryClient } from '../oci-registry-client.js'
import { EnvironmentWorkloadFactory } from '../environment-workload.js'
import { InClusterRegistry } from '../in-cluster-registry.js'
import { EnvServerSeedSource } from '../env-server-seed.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'

class WorkloadFixture
{
    public static readonly HiveId = 'hive-1'
    public static readonly EnvName = 'e1'
    public static readonly PlantedValue = 'planted-secret-value-token'
    public static readonly Image = 'pragmatic-server:dev'
    public static readonly DbImage = 'postgres:16'
    public static readonly ServerPort = 8080
    public static readonly AppName = 'crm'
    public static readonly AppVersion = '1.2.3'
    public static readonly TrustRef = 'trust-root-1'
    public static readonly NoTrustKeyRef = ''
    public static readonly HttpScheme = 'http://'
    public static readonly UiTrustSecret = 'e1-ui-trust'

    public static App()
    {
        return { appName: WorkloadFixture.AppName, appVersion: WorkloadFixture.AppVersion, repo: 'apps/crm', artifactTag: 'v1.2.3', manifestDigest: 'sha256:abc' }
    }

    public static Hive(): HiveRecord
    {
        return {
            id: WorkloadFixture.HiveId, tenantId: 't1', displayName: 'h',
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: WorkloadFixture.PlantedValue },
            registry: { mode: InfraMode.Attach, credentialRef: WorkloadFixture.PlantedValue },
            createdAt: '2026-10-22T00:00:00Z',
        }
    }

    public static Env(template: Template, type: EnvType): EnvironmentRecord
    {
        return {
            name: WorkloadFixture.EnvName, type, template, environmentId: 't1', hiveId: WorkloadFixture.HiveId, hostPort: 8081,
            containerName: 'c', volumeName: 'v', bundleDir: WorkloadFixture.PlantedValue, createdAt: '2026-10-22T00:00:00Z', status: EnvStatus.Running,
        }
    }
}

describe('EnvironmentWorkloadFactory', () =>
{
    it('builds a database-bearing workload for runtime-postgres', () =>
    {
        const w = EnvironmentWorkloadFactory.From(WorkloadFixture.Env(Template.RuntimePostgres, EnvType.Runtime), WorkloadFixture.Hive())
        assert.equal(w.environmentName, WorkloadFixture.EnvName)
        assert.equal(w.hiveId, WorkloadFixture.HiveId)
        assert.equal(w.image, WorkloadFixture.Image)
        assert.equal(w.serverPort, WorkloadFixture.ServerPort)
        assert.ok(w.database)
        assert.equal(w.database.image, WorkloadFixture.DbImage)
        assert.equal(typeof w.database.passwordRef, 'string')
        assert.ok(w.database.passwordRef.length > 0)
    })

    it('omits the database for dev-blank', () =>
    {
        const w = EnvironmentWorkloadFactory.From(WorkloadFixture.Env(Template.DevBlank, EnvType.Development), WorkloadFixture.Hive())
        assert.equal(w.database, undefined)
    })

    it('carries secret names only, never values', () =>
    {
        const w = EnvironmentWorkloadFactory.From(WorkloadFixture.Env(Template.RuntimePostgres, EnvType.Runtime), WorkloadFixture.Hive())
        assert.ok(w.secretRefs.length > 0)
        for (const ref of w.secretRefs)
        {
            assert.equal(typeof ref, 'string')
            assert.notEqual(ref, WorkloadFixture.PlantedValue)
        }
        assert.ok(w.database)
        assert.notEqual(w.database.passwordRef, WorkloadFixture.PlantedValue)
        assert.ok(w.secretRefs.includes(w.database.passwordRef))
        assert.ok(!JSON.stringify(w).includes(WorkloadFixture.PlantedValue))
    })

    it('federates when the record carries an idpBaseDomain, referencing the ca.crt-only Secret', () =>
    {
        const rec = { ...WorkloadFixture.Env(Template.DevBlank, EnvType.Development), idpBaseDomain: 'hive.test' }
        const w = EnvironmentWorkloadFactory.From(rec, WorkloadFixture.Hive())
        assert.deepEqual(w.federation, { baseDomain: 'hive.test', caSecretName: EnvServerSeedSource.IdpCaSecretNameOf(WorkloadFixture.EnvName) })
    })

    it('has no federation when the record has no idpBaseDomain', () =>
    {
        const w = EnvironmentWorkloadFactory.From(WorkloadFixture.Env(Template.DevBlank, EnvType.Development), WorkloadFixture.Hive())
        assert.equal(w.federation, undefined)
    })

    it('maps record.appDeployment into the workload with registry base, trust secret and trust key', () =>
    {
        const app = WorkloadFixture.App()
        const rec = { ...WorkloadFixture.Env(Template.DevBlank, EnvType.Development), appDeployment: app }
        const hive = { ...WorkloadFixture.Hive(), trustRootRef: WorkloadFixture.TrustRef }
        const w = EnvironmentWorkloadFactory.From(rec, hive)
        assert.deepEqual(w.appDeployment, {
            ...app,
            registryPullBase: WorkloadFixture.HttpScheme + InClusterRegistry.PullBase(),
            trustSecretName: EnvServerSeedSource.UiTrustSecretNameOf(WorkloadFixture.EnvName),
            trustKeyRef: WorkloadFixture.TrustRef,
        })
        assert.equal(EnvServerSeedSource.UiTrustSecretNameOf(WorkloadFixture.EnvName), WorkloadFixture.UiTrustSecret)
    })

    it('registryPullBase is an absolute http URL a pod-side OciRegistryClient can use', () =>
    {
        const rec = { ...WorkloadFixture.Env(Template.DevBlank, EnvType.Development), appDeployment: WorkloadFixture.App() }
        const w = EnvironmentWorkloadFactory.From(rec, WorkloadFixture.Hive())
        const base = w.appDeployment!.registryPullBase
        assert.ok(base.startsWith(WorkloadFixture.HttpScheme))
        assert.equal(new URL(base + '/v2/').protocol, 'http:')
        assert.doesNotThrow(() => new OciRegistryClient(base))
    })

    it('falls back to the empty trust key ref when the hive has no trustRootRef', () =>
    {
        const rec = { ...WorkloadFixture.Env(Template.DevBlank, EnvType.Development), appDeployment: WorkloadFixture.App() }
        const w = EnvironmentWorkloadFactory.From(rec, WorkloadFixture.Hive())
        assert.equal(w.appDeployment!.trustKeyRef, WorkloadFixture.NoTrustKeyRef)
    })

    it('has no appDeployment when the record has none', () =>
    {
        const w = EnvironmentWorkloadFactory.From(WorkloadFixture.Env(Template.DevBlank, EnvType.Development), WorkloadFixture.Hive())
        assert.equal(w.appDeployment, undefined)
    })
})
