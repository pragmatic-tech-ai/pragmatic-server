import type { IEnvironmentService } from '../control-plane-host.js'
import { EnvStatus, EnvType, type EnvironmentRecord } from '../environment-record.js'
import type { TenantRecord } from '../platform-records.js'
import { TenantAdminCapabilities, type AdminRoleCapabilities } from '../tenant-api/tenant-admin-capabilities.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import type { TenantSession } from './tenant-session.js'

/** What the desktop app does to an environment: contribute graphs to a Development one, or publish to a Runtime one. */
export enum DesktopAction
{
    Contribute = 'contribute',
    Publish = 'publish',
}

/** The outcome of `DesktopTargets.Check`: allowed now, not allowed at all, or allowed but the env is not running. */
export enum DesktopTargetVerdict
{
    Allowed = 'allowed',
    Forbidden = 'forbidden',
    NotRunning = 'not-running',
}

/** A Check result; `record` is set only when Allowed. */
export type DesktopTargetCheck = { verdict: DesktopTargetVerdict; record?: EnvironmentRecord }

/** One pickable environment: only what the desktop pickers show. */
export type DesktopTargetDto = { name: string; status: EnvStatus }

export type DesktopTargetsDto = { contribute: DesktopTargetDto[]; publish: DesktopTargetDto[] }

/** Derives a session's role capabilities (the profile's source); injectable so tests can model a role without `envs`. */
export type DesktopCapabilitiesSource = (session: TenantSession, tenant: TenantRecord | undefined) => AdminRoleCapabilities

/**
 * The environments a desktop session may act on. Offered == allowed: `For` (the pickers) and `Allows` / `Check` (the action, used
 * by the relay) apply one rule, `IsEligible`: the session holds the environments capability (from the same source the
 * profile reports, computed once per call), the env belongs to the session's tenant, and its type is the action's
 * (Development for contribute, Runtime for publish). `Allows` / `Check` additionally require the env to be running.
 */
export class DesktopTargets
{
    public constructor(
        private readonly service: IEnvironmentService,
        private readonly directory: ITenantDirectory,
        private readonly capabilities: DesktopCapabilitiesSource = (session, tenant) => TenantAdminCapabilities.For(session, tenant))
    {
    }

    public async For(session: TenantSession): Promise<DesktopTargetsDto>
    {
        const mayActOnEnvs = this.MayActOnEnvs(session)
        const records = [...await this.service.ListReconciled()].sort((a, b) => a.name.localeCompare(b.name))
        return {
            contribute: this.Listed(session, mayActOnEnvs, records, DesktopAction.Contribute),
            publish: this.Listed(session, mayActOnEnvs, records, DesktopAction.Publish),
        }
    }

    /** The session's env `envName` when it may run `action` on it now; undefined otherwise (unknown, foreign, wrong type, not running, no capability). */
    public async Allows(session: TenantSession, envName: string, action: DesktopAction): Promise<EnvironmentRecord | undefined>
    {
        const check = await this.Check(session, envName, action)
        return check.verdict === DesktopTargetVerdict.Allowed ? check.record : undefined
    }

    /**
     * Why the session may or may not run `action` on `envName` now, for callers that answer each case differently (the
     * relay: 403 vs 409). Forbidden covers unknown, foreign, wrong-type and no-capability alike, so it is no existence
     * oracle; NotRunning is only reported for an env the session could otherwise act on.
     */
    public async Check(session: TenantSession, envName: string, action: DesktopAction): Promise<DesktopTargetCheck>
    {
        const mayActOnEnvs = this.MayActOnEnvs(session)
        const record = (await this.service.ListReconciled()).find(r => r.name === envName)
        if (record === undefined || !DesktopTargets.IsEligible(session, mayActOnEnvs, record, action))
        {
            return { verdict: DesktopTargetVerdict.Forbidden }
        }
        if (record.status !== EnvStatus.Running)
        {
            return { verdict: DesktopTargetVerdict.NotRunning }
        }
        return { verdict: DesktopTargetVerdict.Allowed, record }
    }

    private MayActOnEnvs(session: TenantSession): boolean
    {
        return this.capabilities(session, this.directory.GetTenant(session.tenantId)).capabilities.envs
    }

    private Listed(session: TenantSession, mayActOnEnvs: boolean, records: readonly EnvironmentRecord[], action: DesktopAction): DesktopTargetDto[]
    {
        return records.filter(r => DesktopTargets.IsEligible(session, mayActOnEnvs, r, action)).map(r => ({ name: r.name, status: r.status }))
    }

    private static IsEligible(session: TenantSession, mayActOnEnvs: boolean, record: EnvironmentRecord, action: DesktopAction): boolean
    {
        return mayActOnEnvs && record.tenantId === session.tenantId && record.type === DesktopTargets.TypeFor(action)
    }

    private static TypeFor(action: DesktopAction): EnvType
    {
        return action === DesktopAction.Contribute ? EnvType.Development : EnvType.Runtime
    }
}
