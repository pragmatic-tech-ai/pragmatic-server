import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlatformSelector } from '../platform-selector.js'
import { NodePlatform } from '../node-platform.js'
import { DeploymentMode } from '../deployment-mode.js'
import type { PlatformServices } from '../platform-services.js'

test('Local with no explicit bundle resolves to a NodePlatform', () =>
{
    assert.ok(PlatformSelector.Resolve(undefined, DeploymentMode.Local) instanceof NodePlatform)
})

test('an explicit bundle wins over the mode', () =>
{
    const explicit = new NodePlatform() as PlatformServices
    assert.equal(PlatformSelector.Resolve(explicit, DeploymentMode.Cloud), explicit)
})

test('Cloud with no explicit bundle throws', () =>
{
    assert.throws(() => PlatformSelector.Resolve(undefined, DeploymentMode.Cloud), /explicit platform bundle/)
})
