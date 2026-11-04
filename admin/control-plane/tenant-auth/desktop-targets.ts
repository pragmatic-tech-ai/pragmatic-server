import type { IEnvironmentService } from '../control-plane-host.js'
import { EnvStatus, EnvType, type EnvironmentRecord } from '../environment-record.js'
import { TenantAdminCapabilities } from '../tenant-api/tenant-admin-capabilities.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import type { TenantSession } from './tenant-session.js'

/** What the desktop app does to an environment: contribute graphs to a Development one, or publish to a Runtime one. */
export enum DesktopAction
{
    Contribute = 'contribute',
    Publish = 'publish',
}

/** One pickable environment: only what the desktop pickers show. */
export type DesktopTargetDto = { name: string; status: EnvStatus }

export type DesktopTargetsDto = { contribute: DesktopTargetDto[]; publish: DesktopTargetDto[] }

/**
 * The environments a desktop session may act on. Offered == allowed: `For` (the pickers) and `Allows` (the action, used
 * by the relay) apply one rule, `IsEligible`: the env belongs to the session's tenant, its type is the action's
 * (Development for contribute, Runtime for publish), and the session holds the environments capability as reported by
 * `TenantAdminCapabilities` (the same source the profile reports). `Allows` additionally requires the env to be running.
 */
export class DesktopTargets
{
    public constructor(private readonly service: IEnvironmentService, private readonly directory: ITenantDirectory)
    {
    }

    public async For(session: TenantSession): Promise<DesktopTargetsDto>
    {
        const records = [...await this.service.ListReconciled()].sort((a, b) => a.name.localeCompare(b.name))
        return {
            contribute: this.Listed(session, records, DesktopAction.Contribute),
            publish: this.Listed(session, records, DesktopAction.Publish),
        }
    }

    /** The session's env `envName` when it may run `action` on it now; undefined otherwise (unknown, foreign, wrong type, not running, no capability). */
    public async Allows(session: TenantSession, envName: string, action: DesktopAction): Promise<EnvironmentRecord | undefined>
    {
        const record = (await this.service.ListReconciled()).find(r => r.name === envName)
        if (record === undefined || !this.IsEligible(session, record, action) || record.status !== EnvStatus.Running)
        {
            return undefined
        }
        return record
    }

    private Listed(session: TenantSession, records: readonly EnvironmentRecord[], action: DesktopAction): DesktopTargetDto[]
    {
        return records.filter(r => this.IsEligible(session, r, action)).map(r => ({ name: r.name, status: r.status }))
    }

    private IsEligible(session: TenantSession, record: EnvironmentRecord, action: DesktopAction): boolean
    {
        return record.tenantId === session.tenantId
            && record.type === DesktopTargets.TypeFor(action)
            && TenantAdminCapabilities.For(session, this.directory.GetTenant(session.tenantId)).capabilities.envs
    }

    private static TypeFor(action: DesktopAction): EnvType
    {
        return action === DesktopAction.Contribute ? EnvType.Development : EnvType.Runtime
    }
}
