import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoragePackageSource } from '@pragmatic-tech-ai/todl'
import { DeliveryChannel, EnvironmentCatalogComposer, type IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'
import { RealmSecurityModel } from '@pragmatic-tech-ai/pragmatic-identity-engine-binding'
import { IdpDirectorySnapshot, type ISecurityModelConfig } from '@pragmatic-tech-ai/pragmatic-identity'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { SecuritySettingCatalogCheck } from '../../../src/host/environment/security-setting-catalog-check.js'
import { BundleBuilder, EnvKind, NorthwindApp } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/** The demo Contoso tier-1 setting and the demo environment's composed catalog (the Northwind delivery). */
class ContosoSeed
{
    /** The demo seed ships in pragmatic-tenant-plane (BundleBuilder.SeedDirOf). */
    public static readonly ModelPath = join(BundleBuilder.SeedDirOf(EnvKind.Demo), BundleBuilder.SecurityModelFile)
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
    const model = RealmSecurityModel.FromConfig(config, IdpDirectorySnapshot.NonAuthoritative(new Date()))
    assert.equal(config.businessUnits.length, ContosoSeed.BusinessUnitCount)
    const issues = SecuritySettingCatalogCheck.Issues(config, await ContosoSeed.Catalog(), model)
    assert.deepEqual(issues.map(issue => issue.Code + ContosoSeed.Separator + issue.Subject), [])
})
