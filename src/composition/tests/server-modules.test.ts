import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HostKinds } from '@pragmatic-tech-ai/todl-runtime'
import { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { SolutionServicesModule, LanguageServiceModule } from '../server-modules.js'

test('SolutionServicesModule manifest targets Server and provides the manager key', () =>
{
    const m = new SolutionServicesModule().Manifest()
    assert.equal(m.Id, 'solution-manager')
    assert.ok(m.Supports(HostKinds.Server))
    assert.deepEqual([...m.Provides], [SolutionManagerService.Key])
})

test('LanguageServiceModule requires solution-manager and provides the language key', () =>
{
    const m = new LanguageServiceModule().Manifest()
    assert.equal(m.Id, 'language-service')
    assert.ok(m.Supports(HostKinds.Server))
    assert.deepEqual([...m.Requires], ['solution-manager'])
    assert.deepEqual([...m.Provides], [SolutionLanguageService.Key])
})
