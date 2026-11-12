import { TeamMembershipRows } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig, TeamMembershipRow } from '@pragmatic-tech-ai/todl-identity'
import type { IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'
import { UnknownTeamError } from '../admin-service.js'
import type { ISecuritySettingAdmin } from '../admin-service.js'
import type { EnvironmentEngineHost } from './environment-engine-host.js'
import type { EnvironmentSecuritySetting } from './environment-security-setting.js'
import { SecuritySettingCatalogCheck } from './security-setting-catalog-check.js'
import type { SecuritySettingIssue } from './security-setting-catalog-check.js'

/** What `EnvironmentSecurityAdmin` needs of the IdP directory sync host: a request to run it now. */
export interface IDirectorySyncTrigger
{
    RunNow(): Promise<void>
}

/**
 * The admin save and reads' view of a Runtime environment's security (AdminService): a candidate setting checked
 * against the environment's deployed packages (SecuritySettingCatalogCheck over the model the candidate builds on the
 * current directory snapshot), the live reload of the stored one, the environment's security catalog and a team's
 * effective membership, and the request to re-sync the IdP directory after a save.
 */
export class EnvironmentSecurityAdmin implements ISecuritySettingAdmin
{
    public constructor(
        private readonly setting: EnvironmentSecuritySetting,
        private readonly host: Pick<EnvironmentEngineHost, 'Snapshot'>,
        private readonly sync: IDirectorySyncTrigger)
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

    public async Catalog(): Promise<IEnvironmentCatalog>
    {
        return (await this.host.Snapshot()).Catalog
    }

    public async TeamMembers(teamId: string): Promise<readonly TeamMembershipRow[]>
    {
        const config = await this.setting.Config()
        if (config === undefined || !config.teams.some(team => team.id === teamId))
        {
            throw new UnknownTeamError(teamId)
        }
        return TeamMembershipRows.For(config, await this.setting.Snapshot()).Rows(teamId)
    }

    public RequestSync(): void
    {
        void this.sync.RunNow()
    }
}
