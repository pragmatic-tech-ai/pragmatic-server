import { TeamMembershipRows } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig, TeamMembershipRow } from '@pragmatic-tech-ai/todl-identity'
import type { IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'
import { UnknownTeamError } from '../admin-service.js'
import type { ISecuritySettingAdmin } from '../admin-service.js'
import type { EnvironmentEngineHost } from './environment-engine-host.js'
import type { EnvironmentSecuritySetting } from './environment-security-setting.js'
import type { SecurityChangeLog } from './security-change-log.js'
import type { SecurityChangesDto } from '@pragmatic-tech-ai/pragmatic-protocol'
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
 * effective membership, the security change log of its deploys and promotes, and the request to re-sync the IdP
 * directory after a save.
 */
export class EnvironmentSecurityAdmin implements ISecuritySettingAdmin
{
    public constructor(
        private readonly setting: EnvironmentSecuritySetting,
        private readonly host: Pick<EnvironmentEngineHost, 'Snapshot'>,
        private readonly sync: IDirectorySyncTrigger,
        private readonly changes: SecurityChangeLog)
    {
    }

    /** Throws InvalidSecurityModelError when `config` is structurally invalid. */
    public async Issues(config: ISecurityModelConfig): Promise<readonly SecuritySettingIssue[]>
    {
        const model = await this.setting.ModelOf(config)
        const catalog = (await this.host.Snapshot()).Catalog
        return SecuritySettingCatalogCheck.Issues(config, catalog, model)
    }

    /**
     * Runs `write` holding the setting's write lock. With `config`, it is first re-checked against the catalog the stored
     * setting was last reconciled to (a deploy's prospective catalog once it committed): its issues are returned and
     * `write` does not run. Without a reconciled catalog nothing committed since the pre-check, which then stands.
     */
    public Locked(config: ISecurityModelConfig | undefined, write: () => Promise<void>): Promise<readonly SecuritySettingIssue[]>
    {
        return this.setting.Exclusive(async () =>
        {
            const catalog = this.setting.Reconciled
            if (config !== undefined && catalog !== undefined)
            {
                const issues = SecuritySettingCatalogCheck.Issues(config, catalog, await this.setting.ModelOf(config))
                if (issues.length > 0) return issues
            }
            await write()
            return []
        })
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

    public SecurityChanges(): Promise<SecurityChangesDto[]>
    {
        return this.changes.List()
    }

    public RequestSync(): void
    {
        void this.sync.RunNow()
    }
}
