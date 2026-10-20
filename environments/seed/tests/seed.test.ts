import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BundleBuilder, EnvKind, TenantPurposeName } from '../bundle.js'
import type { EnvDefinition } from '../bundle.js'
import type { DockerEnv } from '../docker.js'
import { SeedCli } from '../seed.js'

const Demo: EnvDefinition = { name: 'demo', kind: EnvKind.Demo, tenantId: 'contoso', purpose: TenantPurposeName.Runtime, hostPort: 8081 }

type UpAccess = { Up(d: DockerEnv, def: EnvDefinition, dir: string): Promise<void> }

test('Up rejects (non-zero exit via entry-point catch) when the server image is missing', async () =>
{
    const fakeDocker = { EnsureImage: async () => false } as unknown as DockerEnv
    await assert.rejects((SeedCli as unknown as UpAccess).Up(fakeDocker, Demo, 'any-dir'), /Server image not found/)
})

test('admin credentials derive from the public BundleBuilder constants', () =>
{
    assert.equal(SeedCli.AdminEmail(Demo), BundleBuilder.AdminEmailPrefix + Demo.tenantId + BundleBuilder.AdminEmailSuffix)
    const secrets: Record<string, string> = { [Demo.tenantId + BundleBuilder.AdminSecretSuffix]: 'pw' }
    assert.equal(SeedCli.AdminPassword(Demo, secrets), 'pw')
})
