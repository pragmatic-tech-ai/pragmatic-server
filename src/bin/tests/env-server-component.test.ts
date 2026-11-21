import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnvServerComponent } from '../env-server-component.js'
import { ComponentGolden } from '../../component/tests/component-golden.js'
import { ComponentSources } from '../../component/tests/component-sources.js'

class EnvServerComponentFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Golden = join(EnvServerComponentFixture.Here, 'fixtures', 'pragmatic-env-server.component.json')
    public static readonly Digest = 'sha256:3b6641cc6cfb1cefcbb400532f33916049ced3c2ff8acf729669ef68fc03bf69'
    public static readonly Readers = [ComponentSources.InPackage('@pragmatic-tech-ai/pragmatic-env-cluster', 'config', 'server-config-loader.js')]
    public static readonly Undeclared: readonly string[] = ['PRAGMATIC_MASTER_KEY_B64_ENV']
}

describe('EnvServerComponent', () =>
{
    it('pins the descriptor: golden JSON and content digest', () =>
    {
        ComponentGolden.Check(EnvServerComponent.Descriptor(), EnvServerComponentFixture.Golden, EnvServerComponentFixture.Digest)
    })

    it('declares exactly the variables its configuration readers read', () =>
    {
        ComponentSources.AssertCovers(EnvServerComponent.Descriptor(), EnvServerComponentFixture.Readers, EnvServerComponentFixture.Undeclared)
    })

    it('is named for its release image', () =>
    {
        assert.equal(EnvServerComponent.Descriptor().Name, 'pragmatic-env-server')
    })
})
