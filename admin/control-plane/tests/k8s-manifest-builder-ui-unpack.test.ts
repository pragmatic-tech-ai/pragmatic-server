import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import type { EnvironmentWorkload } from '../environment-workload.js'

class Fixture
{
    public static readonly DataMount = '/pragmatic/data'
    public static readonly TrustKeyRef = 'hive-root'

    public static Workload(withApp: boolean): EnvironmentWorkload
    {
        const workload: EnvironmentWorkload = {
            environmentName: 'dev1',
            environmentId: 'env-dev1-id',
            hiveId: 'hive-a',
            image: 'pragmatic-server:dev',
            serverPort: 8080,
            env: { PRAGMATIC_PORT: '8080' },
            secretRefs: [],
        }
        if (withApp)
        {
            workload.appDeployment = {
                appName: 'crm',
                appVersion: '1.2.3',
                registryPullBase: 'localhost:30500',
                repo: 'apps/crm',
                artifactTag: 'v1.2.3',
                manifestDigest: 'sha256:abc',
                trustSecretName: 'dev1-ui-trust',
                trustKeyRef: Fixture.TrustKeyRef,
            }
        }
        return workload
    }

    public static Deployment(withApp: boolean): any
    {
        const doc = JSON.parse(new K8sManifestBuilder().Render(Fixture.Workload(withApp)))
        return doc.items.find((o: any) => o.kind === 'Deployment' && o.spec.template.spec.initContainers)
    }
}

describe('K8sManifestBuilder UI unpack', () =>
{
    it('adds a second init container with all PRAGMATIC_UI_* env and the trust volume', () =>
    {
        const spec = Fixture.Deployment(true).spec.template.spec
        assert.equal(spec.initContainers.length, 2)
        const init = spec.initContainers[1]
        assert.deepEqual(init.command, ['node', 'dist-tenant-admin/admin/control-plane/bin/pragmatic-ui-unpack.js'])
        const env = Object.fromEntries(init.env.map((e: any) => [e.name, e.value]))
        assert.deepEqual(env, {
            PRAGMATIC_UI_REGISTRY_BASE: 'localhost:30500',
            PRAGMATIC_UI_REPO: 'apps/crm',
            PRAGMATIC_UI_ARTIFACT_TAG: 'v1.2.3',
            PRAGMATIC_UI_SIG_TAG: 'v1.2.3.sig',
            PRAGMATIC_UI_MANIFEST_DIGEST: 'sha256:abc',
            PRAGMATIC_UI_APP_NAME: 'crm',
            PRAGMATIC_UI_APP_VERSION: '1.2.3',
            PRAGMATIC_UI_TRUST_ROOT_REF: Fixture.TrustKeyRef,
            PRAGMATIC_UI_DATA_DIR: Fixture.DataMount,
            PRAGMATIC_UI_TRUST_DIR: '/pragmatic/ui-trust',
        })
        const trustMount = init.volumeMounts.find((m: any) => m.mountPath === env.PRAGMATIC_UI_TRUST_DIR)
        assert.equal(trustMount.readOnly, true)
        assert.ok(init.volumeMounts.some((m: any) => m.mountPath === Fixture.DataMount && !m.readOnly))
        const vol = spec.volumes.find((v: any) => v.name === trustMount.name)
        assert.equal(vol.secret.secretName, 'dev1-ui-trust')
        assert.deepEqual(vol.secret.items, [{ key: 'hive-root.pub', path: 'hive-root.pub' }])
    })

    it('leaves the Deployment unchanged without appDeployment', () =>
    {
        const dep = Fixture.Deployment(false)
        const explicitUndefined = { ...Fixture.Workload(false), appDeployment: undefined }
        const other = JSON.parse(new K8sManifestBuilder().Render(explicitUndefined)).items.find((o: any) => o.kind === 'Deployment' && o.spec.template.spec.initContainers)
        assert.deepEqual(dep, other)
        assert.equal(new K8sManifestBuilder().Render(Fixture.Workload(false)), new K8sManifestBuilder().Render(explicitUndefined))
        assert.equal(dep.spec.template.spec.initContainers.length, 1)
    })

    it('RenderRegistry carries no hive label but keeps the app selector', () =>
    {
        const items = JSON.parse(new K8sManifestBuilder().RenderRegistry('hive-1')).items as any[]
        assert.ok(!JSON.stringify(items).includes('pragmatic/hive'))
        const svc = items.find(o => o.kind === 'Service')
        assert.ok(svc.spec.selector['pragmatic/app'])
    })
})
