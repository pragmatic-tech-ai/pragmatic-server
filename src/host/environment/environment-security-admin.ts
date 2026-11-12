import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import type { ISecuritySettingAdmin } from '../admin-service.js'
import type { EnvironmentEngineHost } from './environment-engine-host.js'
import type { EnvironmentSecuritySetting } from './environment-security-setting.js'
import { SecuritySettingCatalogCheck } from './security-setting-catalog-check.js'
import type { SecuritySettingIssue } from './security-setting-catalog-check.js'

/**
 * The admin save's view of a Runtime environment's security (AdminService): a candidate setting checked against the
 * environment's deployed packages (SecuritySettingCatalogCheck over the model the candidate builds on the current
 * directory snapshot), and the live reload of the stored one.
 */
export class EnvironmentSecurityAdmin implements ISecuritySettingAdmin
{
    public constructor(private readonly setting: EnvironmentSecuritySetting, private readonly host: Pick<EnvironmentEngineHost, 'Snapshot'>)
    {
    }

    /** Throws InvalidSecurityModelError when `config` is structurally invalid. */
    public async Issues(config: ISecurityModelConfig): Promise<readonly SecuritySettingIssue[]>
    {
        const model = await this.setting.ModelOf(config)
        const catalog = (await this.host.Snapshot()).Catalog
        return SecuritySettingCatalogCheck.Issues(config, catalog, model)
    }

    public Invalidate(): void
    {
        this.setting.Invalidate()
    }
}
