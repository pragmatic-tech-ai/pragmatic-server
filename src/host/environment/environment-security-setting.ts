import type { ISignal } from '@pragmatic-tech-ai/graph'
import { IdentityConfig, IdpDirectorySnapshot, InvalidSecurityModelError, UnreadableIdpDirectoryRecordError } from '@pragmatic-tech-ai/todl-identity'
import type { IIdpDirectoryStore, ISecurityModelConfig, ITenantConfigStore, Tenant } from '@pragmatic-tech-ai/todl-identity'
import { TenantSecurityModel } from '@pragmatic-tech-ai/todl-identity-engine'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { StructuredLogger } from '../../observability/logger.js'
import type { ILogger } from '../../observability/logger.js'
import { VoidSignal } from '../engine/access-scope-source.js'

/** Where an unreadable stored setting is reported (once per generation). */
export interface ISecuritySettingDiagnostics
{
    Unreadable(tenantId: string, error: Error): void
}

/** Reports an unreadable setting as one warning on the server logger, by error name only (no setting content). */
export class LoggerSecuritySettingDiagnostics implements ISecuritySettingDiagnostics
{
    private static readonly Line = 'security setting unreadable, environment denies all access: tenant '
    private static readonly Separator = ': '

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public Unreadable(tenantId: string, error: Error): void
    {
        this.logger.Warn(LoggerSecuritySettingDiagnostics.Line + tenantId + LoggerSecuritySettingDiagnostics.Separator + error.name)
    }
}

/**
 * The environment's security setting (contract C5) as the runtime reads it: the stored `ISecurityModelConfig` and the
 * `TenantSecurityModel` built from it over the stored IdP directory snapshot (none stored: a non-authoritative one).
 *
 * Fail closed: no setting stored is `TenantSecurityModel.Empty()` (nobody holds a role, so tier 1 grants nothing on an
 * engine-stored concept); so is a stored setting the store refuses (`InvalidSecurityModelError`) or a directory record
 * it cannot trust (`UnreadableIdpDirectoryRecordError`), each reported once per generation. Any other error propagates
 * (a later call retries). The model is built once per generation; `Invalidate` drops it, bumps `Generation` and raises
 * `Changed`, so scopes and cursors compiled before an edit are superseded. The generation is per process.
 */
export class EnvironmentSecuritySetting implements IDisposable
{
    public readonly Changed: ISignal<void>

    private readonly changed = new VoidSignal()
    private model: Promise<TenantSecurityModel> | undefined
    private generation = 0
    private disposed = false

    public constructor(
        private readonly store: ITenantConfigStore,
        private readonly directory: IIdpDirectoryStore,
        private readonly tenant: Tenant,
        private readonly diagnostics: ISecuritySettingDiagnostics = new LoggerSecuritySettingDiagnostics())
    {
        this.Changed = this.changed
    }

    public get Generation(): number
    {
        return this.generation
    }

    /** The stored setting, undefined when none is stored; throws what the store throws. */
    public async Config(): Promise<ISecurityModelConfig | undefined>
    {
        return (await this.store.Get(this.tenant.Id))?.SecurityModel ?? undefined
    }

    /**
     * Stores `config` as the setting, keeping the tenant config's other sections (as the admin save does), then
     * `Invalidate`. Nothing is stored when the tenant has no stored config (it then holds no setting either).
     */
    public async Replace(config: ISecurityModelConfig): Promise<void>
    {
        const stored = await this.store.Get(this.tenant.Id)
        if (stored === null) return
        await this.store.Save(this.tenant.Id, new IdentityConfig(stored.PackId, stored.DelegationDepth, stored.ProviderSettings, stored.GroupRoleMap, stored.ClaimsMapping, config))
        this.Invalidate()
    }

    /** The stored IdP directory snapshot the setting reads (team membership, user states); a non-authoritative one when none is stored. */
    public Snapshot(): Promise<IdpDirectorySnapshot>
    {
        return this.Directory()
    }

    public Model(): Promise<TenantSecurityModel>
    {
        if (this.model === undefined)
        {
            const built = this.Build()
            this.model = built
            built.catch(() =>
            {
                if (this.model === built) this.model = undefined
            })
        }
        return this.model
    }

    /** `config` as a model over the current directory snapshot; throws InvalidSecurityModelError when it is not valid. */
    public async ModelOf(config: ISecurityModelConfig): Promise<TenantSecurityModel>
    {
        return TenantSecurityModel.FromConfig(config, await this.Directory())
    }

    public Invalidate(): void
    {
        if (this.disposed) return
        this.model = undefined
        this.generation += 1
        this.changed.Raise()
    }

    public dispose(): void
    {
        this.disposed = true
        this.model = undefined
    }

    private async Build(): Promise<TenantSecurityModel>
    {
        try
        {
            const config = await this.Config()
            return config === undefined ? TenantSecurityModel.Empty() : TenantSecurityModel.FromConfig(config, await this.Directory())
        }
        catch (error)
        {
            if (error instanceof InvalidSecurityModelError || error instanceof UnreadableIdpDirectoryRecordError)
            {
                this.diagnostics.Unreadable(this.tenant.Id, error)
                return TenantSecurityModel.Empty()
            }
            throw error
        }
    }

    private async Directory(): Promise<IdpDirectorySnapshot>
    {
        return (await this.directory.Get(this.tenant.Id)) ?? IdpDirectorySnapshot.NonAuthoritative(new Date())
    }
}
