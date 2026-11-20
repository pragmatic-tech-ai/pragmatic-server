import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PlatformAdminComponent } from '../platform-admin-component.js'
import { TenantAdminEnv } from '../tenant-admin-env.js'
import { ComponentGolden } from '../../../src/component/tests/component-golden.js'
import { ComponentSources } from '../../../src/component/tests/component-sources.js'

class PlatformAdminComponentFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Golden = join(PlatformAdminComponentFixture.Here, 'fixtures', 'pragmatic-platform-admin.component.json')
    public static readonly Digest = 'sha256:bc19deb009e41d7d5dc0b19547410345dc451d11e800499f74ae9f507461898f'
    public static readonly Readers = [['..', 'server.ts'], ['..', 'key-stores.ts'], ['..', 'infra-target-mode.ts'], ['..', 'hosted-kubeconfig.ts'], ['..', 'internal-api-credential.ts'], ['..', 'release', 'release-catalog-config.ts'], ['..', 'platform-admin-database.ts']].map(path => join(PlatformAdminComponentFixture.Here, ...path))
    /**
     * PRAGMATIC_ADMIN_OPERATOR_PASSWORD: the inline alternative of operatorPassword (the declared source is the file).
     * PRAGMATIC_AGENT_CHANNEL_PORT / _BIND: the admin role serves no agent channel (the edge image does).
     */
    public static readonly Undeclared: readonly string[] = ['PRAGMATIC_ADMIN_OPERATOR_PASSWORD', 'PRAGMATIC_AGENT_CHANNEL_PORT', 'PRAGMATIC_AGENT_CHANNEL_BIND']
    /** The co-hosted tenant plane reads its trusted-proxy flag through TenantAdminEnv.TrustedProxy. */
    public static readonly ReadThrough: readonly string[] = [TenantAdminEnv.TrustedProxy]
}

describe('PlatformAdminComponent', () =>
{
    it('pins the descriptor: golden JSON and content digest', () =>
    {
        ComponentGolden.Check(PlatformAdminComponent.Descriptor(), PlatformAdminComponentFixture.Golden, PlatformAdminComponentFixture.Digest)
    })

    it('declares exactly the variables its configuration readers read', () =>
    {
        ComponentSources.AssertCovers(PlatformAdminComponent.Descriptor(), PlatformAdminComponentFixture.Readers, PlatformAdminComponentFixture.Undeclared, PlatformAdminComponentFixture.ReadThrough)
    })

    it('is named for its release image', () =>
    {
        assert.equal(PlatformAdminComponent.Descriptor().Name, 'pragmatic-platform-admin')
    })
})
