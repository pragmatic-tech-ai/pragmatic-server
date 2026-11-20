import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UiUnpackComponent } from '../ui-unpack-component.js'
import { ComponentGolden } from '../../../src/component/tests/component-golden.js'
import { ComponentSources } from '../../../src/component/tests/component-sources.js'

class UiUnpackComponentFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Golden = join(UiUnpackComponentFixture.Here, 'fixtures', 'pragmatic-ui-unpack.component.json')
    public static readonly Digest = 'sha256:771920a2ca35e083cf0b4be2ee2e99f885d9ced7d31db4070d58be7d0a9e9c3f'
    public static readonly Readers = [['..', 'bin', 'pragmatic-ui-unpack.ts']].map(path => join(UiUnpackComponentFixture.Here, ...path))
    public static readonly Undeclared: readonly string[] = []
}

describe('UiUnpackComponent', () =>
{
    it('pins the descriptor: golden JSON and content digest', () =>
    {
        ComponentGolden.Check(UiUnpackComponent.Descriptor(), UiUnpackComponentFixture.Golden, UiUnpackComponentFixture.Digest)
    })

    it('declares exactly the variables its configuration readers read', () =>
    {
        ComponentSources.AssertCovers(UiUnpackComponent.Descriptor(), UiUnpackComponentFixture.Readers, UiUnpackComponentFixture.Undeclared)
    })

    it('is named for its release image', () =>
    {
        assert.equal(UiUnpackComponent.Descriptor().Name, 'pragmatic-ui-unpack')
    })
})
