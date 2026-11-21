import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnvGatewayComponent } from '../env-gateway-component.js'
import { ComponentGolden } from '../../component/tests/component-golden.js'
import { ComponentSources } from '../../component/tests/component-sources.js'

class EnvGatewayComponentFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Golden = join(EnvGatewayComponentFixture.Here, 'fixtures', 'pragmatic-env-gateway.component.json')
    public static readonly Digest = 'sha256:027f1f68e9b00164131f0aae8012b1ca6c926f94f6adbae331bf2f0b539e1ebe'
    public static readonly Readers = [ComponentSources.InPackage('@pragmatic-tech-ai/pragmatic-env-cluster', 'config', 'server-config-loader.js')]
}

describe('EnvGatewayComponent', () =>
{
    it('pins the descriptor: golden JSON and content digest', () =>
    {
        ComponentGolden.Check(EnvGatewayComponent.Descriptor(), EnvGatewayComponentFixture.Golden, EnvGatewayComponentFixture.Digest)
    })

    it('declares only variables ServerConfigLoader reads (LoadGateway reads a subset of them)', () =>
    {
        ComponentSources.AssertDeclaredRead(EnvGatewayComponent.Descriptor(), EnvGatewayComponentFixture.Readers)
    })

    it('is named for its release image', () =>
    {
        assert.equal(EnvGatewayComponent.Descriptor().Name, 'pragmatic-env-gateway')
    })
})
