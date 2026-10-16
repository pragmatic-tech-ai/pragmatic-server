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
})
