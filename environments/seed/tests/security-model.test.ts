import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { StoragePackageSource } from '@pragmatic-tech-ai/todl'
import { DeliveryChannel, EnvironmentCatalogComposer } from '@pragmatic-tech-ai/todl/engine'
import type { IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'
import { TenantSecurityModel } from '@pragmatic-tech-ai/todl-identity-engine'
import { IdpDirectorySnapshot } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { SecuritySettingCatalogCheck } from '../../../src/host/environment/security-setting-catalog-check.js'
import { NorthwindApp } from '../compile.js'

/** The demo Contoso tier-1 setting and the demo environment's composed catalog (the Northwind delivery). */
class ContosoSeed
{
    public static readonly ModelPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'demo', 'seed', 'security-model.json')
    public static readonly BusinessUnitCount = 6
    public static readonly Separator = ':'
    private static readonly TempPrefix = 'nw-sec-'

    public static Config(): ISecurityModelConfig
    {
        return JSON.parse(readFileSync(ContosoSeed.ModelPath, 'utf8')) as ISecurityModelConfig
    }

    public static async Catalog(): Promise<IEnvironmentCatalog>
    {
        const dir = mkdtempSync(join(tmpdir(), ContosoSeed.TempPrefix))
        await NorthwindApp.Compile(dir)
        return EnvironmentCatalogComposer.Compose({
            Deliveries: [{ Channel: DeliveryChannel.Deploy, Name: NorthwindApp.AppName, Packages: [{ model: NorthwindApp.Id, version: NorthwindApp.Version }] }],
            Packages: new StoragePackageSource(new NodeFsStorage(dir)),
        })
    }
}

test('Contoso security model is valid against the demo catalog (nothing a first open would prune)', async () =>
{
    const config = ContosoSeed.Config()
    const model = TenantSecurityModel.FromConfig(config, IdpDirectorySnapshot.NonAuthoritative(new Date()))
    assert.equal(config.businessUnits.length, ContosoSeed.BusinessUnitCount)
    const issues = SecuritySettingCatalogCheck.Issues(config, await ContosoSeed.Catalog(), model)
    assert.deepEqual(issues.map(issue => issue.Code + ContosoSeed.Separator + issue.Subject), [])
})
