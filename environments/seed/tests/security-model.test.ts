import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { TenantSecurityModel } from '@pragmatic-tech-ai/todl-identity-engine'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'

const ModelPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'demo', 'seed', 'security-model.json')

test('Contoso security model loads (fail-closed validation passes)', () =>
{
    const config = JSON.parse(readFileSync(ModelPath, 'utf8')) as ISecurityModelConfig
    assert.doesNotThrow(() => TenantSecurityModel.FromConfig(config))
    assert.equal(config.businessUnits.length, 6)
    assert.equal(config.roles.length, 3)
    assert.deepEqual(config.roles.map(r => r.id).sort(), ['reader', 'salesManager', 'salesRep'])
    const overrides = config.fieldSecurity!.profileAssignment!.overrides
    for (const principalId of ['manager-north', 'finance'])
    {
        assert.ok(overrides.some(o => o.principalId === principalId && o.profiles.includes('credit-readers')))
    }
})
