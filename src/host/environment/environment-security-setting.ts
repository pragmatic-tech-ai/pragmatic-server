import type { ISignal } from '@pragmatic-tech-ai/pragmatic-graph'
import { IdentityConfig, IdpDirectorySnapshot, InvalidSecurityModelError, UnreadableIdpDirectoryRecordError, type IIdpDirectoryStore, type ISecurityModelConfig, type IRealmConfigStore, type Realm } from '@pragmatic-tech-ai/pragmatic-identity'
import { RealmSecurityModel } from '@pragmatic-tech-ai/pragmatic-identity-engine-binding'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import type { IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'
import { AsyncMutex } from '../cypher/async-mutex.js'
import { StructuredLogger, type ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import { VoidSignal } from '../engine/access-scope-source.js'

/** Where an unreadable stored setting is reported (once per generation). */
export interface ISecuritySettingDiagnostics
{
    Unreadable(environmentId: string, error: Error): void
}

/** Reports an unreadable setting as one warning on the server logger, by error name only (no setting content). */
export class LoggerSecuritySettingDiagnostics implements ISecuritySettingDiagnostics
{
    private static readonly Line = 'security setting unreadable, environment denies all access: environment '
    private static readonly Separator = ': '

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public Unreadable(environmentId: string, error: Error): void
    {
        this.logger.Warn(LoggerSecuritySettingDiagnostics.Line + environmentId + LoggerSecuritySettingDiagnostics.Separator + error.name)
    }
}

/**
 * The environment's security setting (contract C5) as the runtime reads it: the stored `ISecurityModelConfig` and the
 * `RealmSecurityModel` built from it over the stored IdP directory snapshot (none stored: a non-authoritative one).
 *
 * Fail closed: no setting stored is `RealmSecurityModel.Empty()` (nobody holds a role, so tier 1 grants nothing on an
 * engine-stored concept); so is a stored setting the store refuses (`InvalidSecurityModelError`) or a directory record
 * it cannot trust (`UnreadableIdpDirectoryRecordError`), each reported once per generation. Any other error propagates
 * (a later call retries). The model is built once per generation; `Invalidate` drops it, bumps `Generation` and raises
 * `Changed`, so scopes and cursors compiled before an edit are superseded. The generation is per process.
 *
 * Every write of the stored setting (the admin save, a deploy's prune) runs inside `Exclusive`, so a read-modify-write
 * never loses or reverts another. `Reconciled` is the catalog the stored setting was last checked against inside the
 * lock (a deploy's prospective catalog at its commit, or the running one at open): an admin save re-checks against it
 * under the lock, so an entry checked against a catalog a deploy is replacing is refused, not stored.
 */
export class EnvironmentSecuritySetting implements IDisposable
{
    public readonly Changed: ISignal<void>

    private readonly changed = new VoidSignal()
    private readonly mutex = new AsyncMutex()
    private reconciled: IEnvironmentCatalog | undefined
    private model: Promise<RealmSecurityModel> | undefined
    private generation = 0
    private disposed = false

    public constructor(
        private readonly store: IRealmConfigStore,
        private readonly directory: IIdpDirectoryStore,
        private readonly realm: Realm,
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
        return (await this.store.Get(this.realm.Id))?.SecurityModel ?? undefined
    }

    /** The catalog the stored setting was last reconciled against (undefined until a commit or an open reconciled it). */
    public get Reconciled(): IEnvironmentCatalog | undefined
    {
        return this.reconciled
    }

    /** Runs `section` holding the setting's write lock (not reentrant: `section` must not call `Exclusive`). */
    public Exclusive<T>(section: () => Promise<T>): Promise<T>
    {
        return this.mutex.Run(section)
    }

    /** Records that the stored setting now holds nothing `catalog` cannot mean; call inside `Exclusive`. */
    public Reconcile(catalog: IEnvironmentCatalog): void
    {
        this.reconciled = catalog
    }

    /**
     * Stores `config` as the setting, keeping the realm config's other sections (as the admin save does), then
     * `Invalidate`; call inside `Exclusive`. Nothing is stored when the realm has no stored config (it then holds no
     * setting either).
     */
    public async Replace(config: ISecurityModelConfig): Promise<void>
    {
        const stored = await this.store.Get(this.realm.Id)
        if (stored === null) return
        await this.store.Save(this.realm.Id, new IdentityConfig(stored.PackId, stored.DelegationDepth, stored.ProviderSettings, stored.GroupRoleMap, stored.ClaimsMapping, config))
        this.Invalidate()
    }

    /** The stored IdP directory snapshot the setting reads (team membership, user states); a non-authoritative one when none is stored. */
    public Snapshot(): Promise<IdpDirectorySnapshot>
    {
        return this.Directory()
    }

    public Model(): Promise<RealmSecurityModel>
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
    public async ModelOf(config: ISecurityModelConfig): Promise<RealmSecurityModel>
    {
        return RealmSecurityModel.FromConfig(config, await this.Directory())
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

    private async Build(): Promise<RealmSecurityModel>
    {
        try
        {
            const config = await this.Config()
            return config === undefined ? RealmSecurityModel.Empty() : RealmSecurityModel.FromConfig(config, await this.Directory())
        }
        catch (error)
        {
            if (error instanceof InvalidSecurityModelError || error instanceof UnreadableIdpDirectoryRecordError)
            {
                this.diagnostics.Unreadable(this.realm.Id, error)
                return RealmSecurityModel.Empty()
            }
            throw error
        }
    }

    private async Directory(): Promise<IdpDirectorySnapshot>
    {
        return (await this.directory.Get(this.realm.Id)) ?? IdpDirectorySnapshot.NonAuthoritative(new Date())
    }
}
