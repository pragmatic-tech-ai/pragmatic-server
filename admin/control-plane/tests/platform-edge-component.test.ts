import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PlatformEdgeComponent } from '../platform-edge-component.js'
import { ComponentGolden } from '../../../src/component/tests/component-golden.js'
import { ComponentSources } from '../../../src/component/tests/component-sources.js'

class PlatformEdgeComponentFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Golden = join(PlatformEdgeComponentFixture.Here, 'fixtures', 'pragmatic-platform-edge.component.json')
    public static readonly Digest = 'sha256:f8e6ed26594d13a07d6a35f48ad93bcdbede400637a431f9c16a8a3305a4ad8c'
    public static readonly Readers = [['..', 'edge-composition.ts']].map(path => join(PlatformEdgeComponentFixture.Here, ...path))
    /** PRAGMATIC_CONTROL_PLANE_ROLE: fixed to edge by the image, not configuration. */
    public static readonly Undeclared: readonly string[] = ['PRAGMATIC_CONTROL_PLANE_ROLE']
}

describe('PlatformEdgeComponent', () =>
{
    it('pins the descriptor: golden JSON and content digest', () =>
    {
        ComponentGolden.Check(PlatformEdgeComponent.Descriptor(), PlatformEdgeComponentFixture.Golden, PlatformEdgeComponentFixture.Digest)
    })

    it('declares exactly the variables its configuration readers read', () =>
    {
        ComponentSources.AssertCovers(PlatformEdgeComponent.Descriptor(), PlatformEdgeComponentFixture.Readers, PlatformEdgeComponentFixture.Undeclared)
    })

    it('is named for its release image', () =>
    {
        assert.equal(PlatformEdgeComponent.Descriptor().Name, 'pragmatic-platform-edge')
    })
})
