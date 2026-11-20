import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HiveAgentComponent } from '../hive-agent-component.js'
import { ComponentGolden } from '../../component/tests/component-golden.js'
import { ComponentSources } from '../../component/tests/component-sources.js'

class HiveAgentComponentFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Golden = join(HiveAgentComponentFixture.Here, 'fixtures', 'pragmatic-hive-agent.component.json')
    public static readonly Digest = 'sha256:8a59fe48b0e4d9f3fe7445a637d176d31a2b2009822de18dc1f17d4227267eff'
    public static readonly Readers = [['..', 'agent-main.ts']].map(path => join(HiveAgentComponentFixture.Here, ...path))
    public static readonly Undeclared: readonly string[] = []
}

describe('HiveAgentComponent', () =>
{
    it('pins the descriptor: golden JSON and content digest', () =>
    {
        ComponentGolden.Check(HiveAgentComponent.Descriptor(), HiveAgentComponentFixture.Golden, HiveAgentComponentFixture.Digest)
    })

    it('declares exactly the variables its configuration readers read', () =>
    {
        ComponentSources.AssertCovers(HiveAgentComponent.Descriptor(), HiveAgentComponentFixture.Readers, HiveAgentComponentFixture.Undeclared)
    })

    it('is named for its release image', () =>
    {
        assert.equal(HiveAgentComponent.Descriptor().Name, 'pragmatic-hive-agent')
    })
})
