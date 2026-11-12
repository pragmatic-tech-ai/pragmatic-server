import type { GraphEngine } from '@pragmatic-tech-ai/graph'
import { OwnershipAssignment, SystemNames } from '@pragmatic-tech-ai/todl/engine'
import type { IEnvironmentCatalog, IOwnerAssignment } from '@pragmatic-tech-ai/todl/engine'
import { InvalidSecurityModelError, UnreadableIdpDirectoryRecordError } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { TenantSecurityModel } from '@pragmatic-tech-ai/todl-identity-engine'
import type { SecurityChangesDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IGraphScope } from '../engine/access-scope-source.js'
import { AsyncMutex } from '../cypher/async-mutex.js'
import type { EnvironmentSnapshot } from './environment-engine-host.js'
import type { EnvironmentSecuritySetting } from './environment-security-setting.js'
import type { PendingBackfillStore } from './pending-backfill-store.js'
import type { SecurityChangeLog } from './security-change-log.js'
import { SecurityDeployDiff } from './security-deploy-diff.js'
import { AssignScope } from './service-scopes.js'
import type { SystemPrincipalScope } from './system-principal-scope.js'

/** The stored setting and the model built from it. */
interface IStoredSetting
{
    readonly Config: ISecurityModelConfig
    readonly Model: TenantSecurityModel
}

/**
 * What a deploy or promote does to the environment's security (S4 Task 13; EnvironmentEngineHost.Deliver runs it):
 *
 * - `Diff`: the SecurityDeployDiff of the running catalog against the prospective one over the stored setting (none
 *   stored, or one the setting cannot read: nothing is pruned; the environment denies all anyway).
 * - `Expect` (before the persist step): records the diff's newly owned concepts in the durable PendingBackfillStore.
 * - `Commit` (after the persist step, before the catalog swap): under the setting's write lock, re-reads the stored
 *   setting, recomputes the dropped entries from it against the prospective catalog (an admin save during the persist
 *   is pruned too), stores the setting pruned of them, invalidates it and marks the prospective catalog as reconciled
 *   (fail closed: it only narrows access a moment before the swap); then logs a non-empty diff and returns the entry.
 * - `Reconcile` (at every open, before the engine is launched): the same commit of the running catalog against itself,
 *   so a prune a crash or a lost lease kept from committing lands before anything is served (Review Focus 1).
 * - `Backfill` (after the swap and after every open): every pending concept the running catalog owns gets its
 *   ownerless records `owner = system:<env>` and the root business unit (PR16), one transaction per concept under the
 *   system principal's assign scope (`SystemPrincipalScope.AssignScope`, PR2) confined by `AssignScope.ForRecords` to
 *   those records' system fields, each written through TODL's `OwnershipAssignment.Assign`, under the system
 *   principal's connector context; a concept leaves the pending list once its transaction committed. Serialized.
 */
export class DeliverySecurity
{
    /** The delivery a change-log entry names when the open reconciled the setting (no deploy or promote made it). */
    public static readonly ReconcileDelivery = 'reconciled at environment open'
    private static readonly SystemFields: ReadonlySet<string> = new Set<string>([SystemNames.Owner, SystemNames.OwningBusinessUnit])

    private readonly backfill = new AsyncMutex()

    public constructor(
        private readonly setting: EnvironmentSecuritySetting,
        private readonly log: SecurityChangeLog,
        /** The system principal's scopes, resolved when the backfill runs (they are built over the engine host). */
        private readonly system: () => Promise<SystemPrincipalScope>,
        private readonly pending: PendingBackfillStore)
    {
    }

    public async Diff(current: IEnvironmentCatalog, prospective: IEnvironmentCatalog): Promise<SecurityDeployDiff>
    {
        const stored = await this.Readable()
        return SecurityDeployDiff.Compute(current, prospective, stored?.Config, stored?.Model ?? TenantSecurityModel.Empty())
    }

    /** Records the diff's newly owned concepts as owed a backfill (durably, before the delivery persists). */
    public async Expect(diff: SecurityDeployDiff): Promise<void>
    {
        if (diff.NewlyOwned.length > 0) await this.pending.Add(diff.NewlyOwned)
    }

    /** Prunes the stored setting (recomputed from it as stored now), then logs a non-empty diff; the logged entry, or undefined. */
    public async Commit(diff: SecurityDeployDiff, delivery: string, version: string): Promise<SecurityChangesDto | undefined>
    {
        const applied = await this.setting.Exclusive(async () =>
        {
            const stored = await this.Readable()
            const rebased = diff.Rebased(stored?.Config, stored?.Model ?? TenantSecurityModel.Empty())
            if (stored !== undefined && rebased.Prunes) await this.setting.Replace(rebased.Pruned(stored.Config))
            this.setting.Reconcile(rebased.Prospective)
            return rebased
        })
        if (applied.IsEmpty) return undefined
        const entry: SecurityChangesDto = { at: new Date().toISOString(), delivery, version, ...applied.Changes }
        await this.log.Append(entry)
        return entry
    }

    /** Prunes what the stored setting holds that `catalog` (the one about to run) cannot mean; logged when anything is. */
    public async Reconcile(catalog: IEnvironmentCatalog, version: string): Promise<void>
    {
        await this.Commit(SecurityDeployDiff.Compute(catalog, catalog, undefined, TenantSecurityModel.Empty()), DeliverySecurity.ReconcileDelivery, version)
    }

    /** Owns the ownerless records of every pending concept the running catalog owns by the system principal; the number written. */
    public Backfill(engine: GraphEngine, snapshot: EnvironmentSnapshot): Promise<number>
    {
        return this.backfill.Run(async () =>
        {
            const owned = snapshot.Catalog.Security.OwnedConcepts()
            const concepts = (await this.pending.List()).filter(concept => owned.has(concept))
            if (concepts.length === 0) return 0
            const system = await this.system()
            const scope = await system.Scope()
            const owner: IOwnerAssignment = { OwnerId: system.PrincipalId, BusinessUnitId: (await this.setting.Model()).Hierarchy().RootId() }
            const assignment = new OwnershipAssignment(owned)
            let written = 0
            for (const concept of concepts)
            {
                written += await DeliverySecurity.BackfillConcept(engine, snapshot, system, scope, concept, owner, assignment)
                await this.pending.Remove([concept])
            }
            return written
        })
    }

    private static async BackfillConcept(engine: GraphEngine, snapshot: EnvironmentSnapshot, system: SystemPrincipalScope, scope: IGraphScope, concept: string,
        owner: IOwnerAssignment, assignment: OwnershipAssignment): Promise<number>
    {
        const records = await DeliverySecurity.Ownerless(engine, scope, concept)
        if (records.size === 0) return 0
        const base = await system.AssignScope()
        const transaction = await engine.Begin(AssignScope.ForRecords(base, concept, records, DeliverySecurity.SystemFields, snapshot.SchemaCatalog), { Connector: scope.Connector })
        let written = 0
        try
        {
            for (const record of records)
            {
                // read again inside the transaction (recorded): a record assigned meanwhile conflicts the commit
                if (DeliverySecurity.HasOwner(await transaction.GetProperty(record, SystemNames.Owner))) continue
                await assignment.Assign(transaction, record, owner)
                written++
            }
            await transaction.Commit()
        }
        finally
        {
            transaction.dispose()
        }
        return written
    }

    /** The stored setting and its model, or undefined when none is stored or it cannot be read (nothing to prune then). */
    private async Readable(): Promise<IStoredSetting | undefined>
    {
        try
        {
            const config = await this.setting.Config()
            return config === undefined ? undefined : { Config: config, Model: await this.setting.ModelOf(config) }
        }
        catch (error)
        {
            if (error instanceof InvalidSecurityModelError || error instanceof UnreadableIdpDirectoryRecordError) return undefined
            throw error
        }
    }

    /** The records whose concept is exactly `concept` and that carry no owner (subconcepts are their own pending entries). */
    private static async Ownerless(engine: GraphEngine, scope: IGraphScope, concept: string): Promise<ReadonlySet<string>>
    {
        const records = new Set<string>()
        const reader = await engine.BeginRead(scope.Scope, { Connector: scope.Connector })
        try
        {
            for await (const record of reader.ScanNodes(concept))
            {
                if (await reader.ConceptOf(record) !== concept) continue
                if (!DeliverySecurity.HasOwner(await reader.GetProperty(record, SystemNames.Owner))) records.add(record)
            }
        }
        finally
        {
            reader.dispose()
        }
        return records
    }

    private static HasOwner(value: unknown): boolean
    {
        return typeof value === 'string' && value.length > 0
    }
}
