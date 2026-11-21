import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostedClusterRefMissingError, HostedHiveOrchestratorFactory } from '../hosted-hive-orchestrator-factory.js'
import { HostedKubeconfig } from '../hosted-kubeconfig.js'
import { UnsupportedBackendError } from '../hive-orchestrator.js'
import { KubectlHiveOrchestrator } from '../kubectl-hive-orchestrator.js'
import { NoInfraTargetBackendError } from '../no-infra-target.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'
import { RegistryRefImageDigest } from '../image-digest.js'
import { ControlPlaneServer } from '../server.js'
import { InfraTargetMode } from '../infra-target-mode.js'
import { ManifestRegistry } from '../manifest-record.js'
import { DevPlatformImages, ReleasePlatformImages } from '../platform-images.js'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

class HostedFixture
{
    public static readonly Context = 'pragmatic-hive'
    public static readonly Setting = 'PRAGMATIC_ADMIN_KUBECONFIG_FILE'
    public static readonly BadFileCopy = 'PRAGMATIC_ADMIN_KUBECONFIG_FILE must name a readable kubeconfig file'
    public static readonly MissingRefCopy = "a hosted hive must name its cluster's kubeconfig context (configRef)"
    public static readonly Kubeconfig = 'apiVersion: v1\nkind: Config\nclusters:\n- name: pragmatic-hive\n  cluster:\n    server: https://100.64.0.3:16443\ncontexts: []\nusers: []\n'
    public static readonly NotKubeconfig = 'secret-looking-text: do-not-echo-me\n'
    public static readonly SecretText = 'do-not-echo-me'
    public static readonly JsonKubeconfig = JSON.stringify({ apiVersion: 'v1', kind: 'Config', clusters: [], contexts: [], users: [] })
    public static readonly HiveId = 'pragmatic'
    public static readonly DataDir = 'hosted-mode-data'
    public static readonly FileDirPrefix = 'hosted-kubeconfig-'
    public static readonly FileName = 'hosted_kubeconfig'
    public static readonly CreatedAt = '2026-11-19T00:00:00.000Z'

    public static Hive(backend: HiveBackend, mode: InfraMode, configRef?: string): HiveRecord
    {
        const id = HostedFixture.HiveId
        return { id, tenantId: id, displayName: id, cluster: { backend, mode, configRef }, registry: { mode: InfraMode.Attach, endpoint: '' }, createdAt: HostedFixture.CreatedAt }
    }

    public static Factory(): HostedHiveOrchestratorFactory
    {
        return new HostedHiveOrchestratorFactory(undefined, join(tmpdir(), HostedFixture.DataDir), new RegistryRefImageDigest())
    }

    public static WithFile(content: string | undefined, body: (path: string) => void): void
    {
        const dir = mkdtempSync(join(tmpdir(), HostedFixture.FileDirPrefix))
        try
        {
            const path = join(dir, HostedFixture.FileName)
            if (content !== undefined)
            {
                writeFileSync(path, content)
            }
            body(path)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }
}

describe('HostedHiveOrchestratorFactory', () =>
{
    it('drives an attached Local hive through its configRef context', () =>
    {
        const orchestrator = HostedFixture.Factory().For(HostedFixture.Hive(HiveBackend.Local, InfraMode.Attach, HostedFixture.Context))
        assert.ok(orchestrator instanceof KubectlHiveOrchestrator)
        const kubectl = (orchestrator as unknown as { kubectl: { context: string } }).kubectl
        assert.equal(kubectl.context, HostedFixture.Context)
    })

    it('refuses an attached Local hive without a configRef, with the copy, as a 400-class backend error', () =>
    {
        assert.throws(() => HostedFixture.Factory().For(HostedFixture.Hive(HiveBackend.Local, InfraMode.Attach)), (err: unknown) =>
            err instanceof HostedClusterRefMissingError && err instanceof UnsupportedBackendError && err.message === HostedFixture.MissingRefCopy)
    })

    it('never provisions: Provision is NoInfraTargetBackendError', () =>
    {
        assert.throws(() => HostedFixture.Factory().For(HostedFixture.Hive(HiveBackend.Local, InfraMode.Provision)), NoInfraTargetBackendError)
    })

    it('keeps other backends unsupported', () =>
    {
        assert.throws(() => HostedFixture.Factory().For(HostedFixture.Hive(HiveBackend.Gke, InfraMode.Attach, HostedFixture.Context)), (err: unknown) =>
            err instanceof UnsupportedBackendError && !(err instanceof HostedClusterRefMissingError) && !(err instanceof NoInfraTargetBackendError))
    })
})

describe('HostedKubeconfig.Apply', () =>
{
    it('sets KUBECONFIG to a valid kubeconfig file', () =>
    {
        HostedFixture.WithFile(HostedFixture.Kubeconfig, path =>
        {
            const env: NodeJS.ProcessEnv = { [HostedFixture.Setting]: path }
            HostedKubeconfig.Apply(env)
            assert.equal(env.KUBECONFIG, path)
        })
    })

    it('refuses an unset setting, a missing file and a non-kubeconfig file with the copy, never the content', () =>
    {
        assert.throws(() => HostedKubeconfig.Apply({}), { message: HostedFixture.BadFileCopy })
        HostedFixture.WithFile(undefined, path =>
        {
            assert.throws(() => HostedKubeconfig.Apply({ [HostedFixture.Setting]: path }), { message: HostedFixture.BadFileCopy })
        })
        HostedFixture.WithFile(HostedFixture.NotKubeconfig, path =>
        {
            const env: NodeJS.ProcessEnv = { [HostedFixture.Setting]: path }
            assert.throws(() => HostedKubeconfig.Apply(env), (err: unknown) =>
                err instanceof Error && err.message === HostedFixture.BadFileCopy && !err.message.includes(HostedFixture.SecretText))
            assert.equal(env.KUBECONFIG, undefined)
        })
    })

    it('accepts a JSON kubeconfig, which kubectl reads too', () =>
    {
        HostedFixture.WithFile(HostedFixture.JsonKubeconfig, path =>
        {
            const env: NodeJS.ProcessEnv = { [HostedFixture.Setting]: path }
            HostedKubeconfig.Apply(env)
            assert.equal(env.KUBECONFIG, path)
        })
    })

    it('refuses a directory (unreadable as a file) with the copy', () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'hosted-kubeconfig-dir-'))
        try
        {
            assert.throws(() => HostedKubeconfig.Apply({ [HostedFixture.Setting]: dir }), { message: HostedFixture.BadFileCopy })
        }
        finally
        {
            chmodSync(dir, 0o755)
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('ControlPlaneServer.PlatformImagesOf', () =>
{
    it('only local runs the dev image; none and hosted offer release images (and refuse until one is verified)', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), HostedFixture.FileDirPrefix))
        try
        {
            const manifests = new ManifestRegistry(join(dir, HostedFixture.FileName))
            await manifests.Load()
            assert.ok(ControlPlaneServer.PlatformImagesOf(InfraTargetMode.Local, manifests, {}) instanceof DevPlatformImages)
            for (const mode of [InfraTargetMode.None, InfraTargetMode.Hosted])
            {
                const images = ControlPlaneServer.PlatformImagesOf(mode, manifests, {})
                assert.ok(images instanceof ReleasePlatformImages, mode)
                assert.equal(images.ImageOf(ReleaseApp.HiveAgent), undefined)
            }
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
