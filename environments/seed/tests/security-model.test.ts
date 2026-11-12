import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { TenantSecurityModel } from '@pragmatic-tech-ai/todl-identity-engine'
import { IdpDirectorySnapshot } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'

/** The demo Contoso tier-1 setting and the values it is expected to carry. */
class ContosoSeed
{
    public static readonly ModelPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'demo', 'seed', 'security-model.json')
    public static readonly BusinessUnitCount = 6
    public static readonly ExpectedRoles: readonly string[] = ['reader', 'salesManager', 'salesRep']
    public static readonly CreditProfile = 'credit-readers'
    public static readonly CreditReaders: readonly string[] = ['manager-north', 'finance']

    public static Config(): ISecurityModelConfig
    {
        return JSON.parse(readFileSync(ContosoSeed.ModelPath, 'utf8')) as ISecurityModelConfig
    }
}

test('Contoso security model loads (fail-closed validation passes)', () =>
{
    const config = ContosoSeed.Config()
    assert.doesNotThrow(() => TenantSecurityModel.FromConfig(config, IdpDirectorySnapshot.NonAuthoritative(new Date())))
    assert.equal(config.businessUnits.length, ContosoSeed.BusinessUnitCount)
    assert.deepEqual([...config.roleAssignments].map(a => a.role).sort(), [...ContosoSeed.ExpectedRoles])
    const credit = config.profileAssignments.find(p => p.profile === ContosoSeed.CreditProfile)!
    for (const principalId of ContosoSeed.CreditReaders)
    {
        assert.ok(credit.principalIds.includes(principalId))
    }
})
