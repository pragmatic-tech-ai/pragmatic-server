import type { GraphEngine } from '@pragmatic-tech-ai/graph'
import { OwnershipAssignment, SystemNames } from '@pragmatic-tech-ai/todl/engine'
import type { IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'
import { InvalidSecurityModelError, UnreadableIdpDirectoryRecordError } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { TenantSecurityModel } from '@pragmatic-tech-ai/todl-identity-engine'
import type { SecurityChangesDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IGraphScope } from '../engine/access-scope-source.js'
import type { EnvironmentSnapshot } from './environment-engine-host.js'
import type { EnvironmentSecuritySetting } from './environment-security-setting.js'
import type { SecurityChangeLog } from './security-change-log.js'
import { SecurityDeployDiff } from './security-deploy-diff.js'
import { AssignScope } from './service-scopes.js'
import type { SystemPrincipalScope } from './system-principal-scope.js'

/**
 * What a deploy or promote does to the environment's security (S4 Task 13; EnvironmentEngineHost.Deliver runs it):
 *
 * - `Diff`: the SecurityDeployDiff of the running catalog against the prospective one over the stored setting (none
 *   stored, or one the setting cannot read: nothing is pruned; the environment denies all anyway).
 * - `Commit` (after the persist step, before the catalog swap): stores the setting pruned of the entries the new
 *   packages cannot mean through the setting's own store and invalidates it (fail closed: it only narrows access a
 *   moment before the swap), then logs a non-empty diff to the change log and returns the logged entry.
 * - `Backfill` (after the swap): every `NewlyOwned` concept's records without an `owner` get `owner = system:<env>`
 *   and the root business unit (PR16), one transaction per concept under the system principal's assign scope
 *   (`SystemPrincipalScope.AssignScope`, PR2) confined by `AssignScope.ForRecords` to those records' system fields,
 *   each written through TODL's `OwnershipAssignment.Assign`. Runs under the system principal's connector context.
 */
export class DeliverySecurity
{
    private static readonly SystemFields: ReadonlySet<string> = new Set<string>([SystemNames.Owner, SystemNames.OwningBusinessUnit])

    public constructor(
        private readonly setting: EnvironmentSecuritySetting,
        private readonly log: SecurityChangeLog,
        /** The system principal's scopes, resolved when the backfill runs (they are built over the engine host). */
        private readonly system: () => Promise<SystemPrincipalScope>)
    {
    }

    public async Diff(current: IEnvironmentCatalog, prospective: IEnvironmentCatalog): Promise<SecurityDeployDiff>
    {
        const stored = await this.Readable()
        return SecurityDeployDiff.Compute(current, prospective, stored?.Config, stored?.Model ?? TenantSecurityModel.Empty())
    }

    /** Prunes the stored setting, then logs a non-empty diff; the logged entry, or undefined when the diff is empty. */
    public async Commit(diff: SecurityDeployDiff, delivery: string, version: string): Promise<SecurityChangesDto | undefined>
    {
        if (diff.Prunes)
        {
            const config = await this.setting.Config()
            if (config !== undefined) await this.setting.Replace(diff.Pruned(config))
        }
        if (diff.IsEmpty) return undefined
        const entry: SecurityChangesDto = { at: new Date().toISOString(), delivery, version, ...diff.Changes }
        await this.log.Append(entry)
        return entry
    }

    /** Owns the ownerless records of every newly owned concept by the system principal; the number of records written. */
    public async Backfill(diff: SecurityDeployDiff, engine: GraphEngine, snapshot: EnvironmentSnapshot): Promise<number>
    {
        const owned = snapshot.Catalog.Security.OwnedConcepts()
        const concepts = diff.NewlyOwned.filter(concept => owned.has(concept))
        if (concepts.length === 0) return 0
        const system = await this.system()
        const scope = await system.Scope()
        const owner = { OwnerId: system.PrincipalId, BusinessUnitId: (await this.setting.Model()).Hierarchy().RootId() }
        const assignment = new OwnershipAssignment(owned)
        let written = 0
        for (const concept of concepts)
        {
            const records = await DeliverySecurity.Ownerless(engine, scope, concept)
            if (records.size === 0) continue
            const base = await system.AssignScope()
            const transaction = await engine.Begin(AssignScope.ForRecords(base, concept, records, DeliverySecurity.SystemFields, snapshot.SchemaCatalog), { Connector: scope.Connector })
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
        }
        return written
    }

    /** The stored setting and its model, or undefined when none is stored or it cannot be read (nothing to prune then). */
    private async Readable(): Promise<{ readonly Config: ISecurityModelConfig; readonly Model: TenantSecurityModel } | undefined>
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

    /** The records whose concept is exactly `concept` and that carry no owner (subconcepts are their own NewlyOwned entries). */
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
