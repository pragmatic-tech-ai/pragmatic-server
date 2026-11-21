import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiKubectl, KubeApiClient, SystemInstallClock, type IKubeTransport, type KubeContentType, type KubeMethod, type KubeResponse } from '@pragmatic-tech-ai/pragmatic-kube'
import { HiveAgentUninstaller, AgentUninstallError } from '../hive-agent-uninstaller.js'
import { HiveBackend, InfraMode, type HiveRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { IInstallOrchestratorSource } from '../hive-agent-installer.js'

/** Answers every API call with one canned response. */
class OneAnswerTransport implements IKubeTransport
{
    public constructor(private readonly answer: KubeResponse)
    {
    }

    public Send(_method: KubeMethod, _path: string, _body: string | undefined, _contentType: KubeContentType): Promise<KubeResponse>
    {
        return Promise.resolve(this.answer)
    }
}

class UninstallFixture
{
    public static readonly Failure: KubeResponse = { status: 500, body: '{"message":"boom"}' }
    public static readonly Hive: HiveRecord = { id: 'h1', tenantId: 't1', displayName: 'h1', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision }, createdAt: '2026-01-01T00:00:00.000Z' }
}

test('a non-forced uninstall over ApiKubectl fails as AgentUninstallError', async () =>
{
    const kubectl = new ApiKubectl(new KubeApiClient(new OneAnswerTransport(UninstallFixture.Failure)), new SystemInstallClock(), { attempts: 5, intervalMs: 0 })
    const source = { For: () => ({ Kubectl: kubectl }) } as unknown as IInstallOrchestratorSource
    await assert.rejects(() => new HiveAgentUninstaller(source).Uninstall(UninstallFixture.Hive), (e: unknown) => e instanceof AgentUninstallError && e.message.includes('status 500'))
})
