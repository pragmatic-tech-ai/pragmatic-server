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

class HostedFixture
{
    public static readonly Context = 'pragmatic-hive'
    public static readonly Setting = 'PRAGMATIC_ADMIN_KUBECONFIG_FILE'
    public static readonly BadFileCopy = 'PRAGMATIC_ADMIN_KUBECONFIG_FILE must name a readable kubeconfig file'
    public static readonly MissingRefCopy = "a hosted hive must name its cluster's kubeconfig context (configRef)"
    public static readonly Kubeconfig = 'apiVersion: v1\nkind: Config\nclusters:\n- name: pragmatic-hive\n  cluster:\n    server: https://100.64.0.3:16443\ncontexts: []\nusers: []\n'
    public static readonly NotKubeconfig = 'secret-looking-text: do-not-echo-me\n'

    public static Hive(backend: HiveBackend, mode: InfraMode, configRef?: string): HiveRecord
    {
        return { id: 'pragmatic', tenantId: 'pragmatic', displayName: 'Pragmatic', cluster: { backend, mode, configRef }, registry: { mode: InfraMode.Attach, endpoint: '' }, createdAt: '2026-11-19T00:00:00.000Z' }
    }

    public static Factory(): HostedHiveOrchestratorFactory
    {
        return new HostedHiveOrchestratorFactory(undefined, join(tmpdir(), 'hosted-mode-data'), new RegistryRefImageDigest())
    }

    public static WithFile(content: string | undefined, body: (path: string) => void): void
    {
        const dir = mkdtempSync(join(tmpdir(), 'hosted-kubeconfig-'))
        try
        {
            const path = join(dir, 'hosted_kubeconfig')
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
                err instanceof Error && err.message === HostedFixture.BadFileCopy && !err.message.includes('do-not-echo-me'))
            assert.equal(env.KUBECONFIG, undefined)
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
