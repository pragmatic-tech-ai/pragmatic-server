import type { AccessScope, GraphEngine, GraphTransaction } from '@pragmatic-tech-ai/graph'
import { OwnershipAssignment, ShareRight, SystemNames } from '@pragmatic-tech-ai/todl/engine'
import type { IOwnerAssignment } from '@pragmatic-tech-ai/todl/engine'
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { AccessDepthEvaluator, AssignOutcome, Tier1Catalog } from '@pragmatic-tech-ai/todl-identity-engine'
import { AppWriteStatus, AssignStatus, ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AssignParams, AssignResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IGraphScopeSource } from '../engine/access-scope-source.js'
import type { EngineSchemaCatalog } from '../engine/engine-schema-catalog.js'
import { EngineWriteFailure } from '../engine/engine-write-failure.js'
import type { EnvironmentEngineHost } from './environment-engine-host.js'
import type { IEnvironmentTier1 } from './environment-scope-rules.js'
import { RecordGrants } from './record-grants.js'
import { AssignScope } from './service-scopes.js'

/**
 * Record assign on the environment engine (ruling S9, amendment A4, program rulings PR2 and C3): moves a record to a
 * new owner, writing only its system fields `owner` and `owningBusinessUnit`, through TODL's `OwnershipAssignment`.
 *
 * - The record's concept is read under the caller's scope first (absent, invisible or not `params.concept` or a
 *   subconcept: `not-found`). A concept that is not owned is `invalid` "the record is organisation-owned and has no
 *   owner" (`AssignOutcome.Unsupported`).
 * - Then ONE transaction under `AssignScope.For(<the caller's assign scope>, concept, id, system fields)`: the assign
 *   scope is `Tier1ScopeCompiler.CompileAssign` with the runtime Finish (EnvironmentScopeRules.AssignRecords, not
 *   under SystemFieldGuard), confined by AssignScope to the one record and its system fields. It reads the record again
 *   (recorded, so a concurrent change conflicts) and authorizes: the caller's tier-1 Assign privilege covers the record
 *   (`RecordGrants.Covers`) or one of its visible grants on the record holds `assign`, else `denied`.
 * - The values come from `AccessDepthEvaluator.AssignWrites(environment, concept, owner, isTeam, owningBu)`: a team
 *   owner takes the team's unit, a placed user its placement, the environment's system principal the root, an unplaced
 *   user the given `owningBu` (unknown: `invalid`; none: `invalid` "an owning business unit is required"); an unknown
 *   team is `invalid`. `OwnershipAssignment.Assign` records them.
 * - Commit: a conflict is `denied` "write conflict"; any other mapped failure `denied` "write failed"; an error outside
 *   EngineWriteFailure propagates (InternalError).
 * - An external record (A4) is `invalid` "external records are outside platform security".
 */
export class EnvironmentAssignService
{
    /** AssignOutcome.Unsupported: the concept does not take the ownership aspect. */
    public static readonly OrganizationOwnedReason = 'the record is organisation-owned and has no owner'
    private static readonly RecordNotFound = 'record not found or not visible'
    private static readonly NotAuthorized = 'not authorized to assign this record'
    private static readonly OwningBuRequired = 'an owning business unit is required'
    private static readonly UnknownBusinessUnit = 'unknown owning business unit'
    private static readonly UnknownTeam = 'unknown team owner'
    private static readonly NoValue = ''
    private static readonly SystemFields: ReadonlySet<string> = new Set<string>([SystemNames.Owner, SystemNames.OwningBusinessUnit])

    public constructor(
        private readonly host: Pick<EnvironmentEngineHost, 'Settled'>,
        private readonly scopes: () => Promise<IGraphScopeSource>,
        private readonly tier1: () => Promise<IEnvironmentTier1>)
    {
    }

    public async Assign(context: AccessContext, params: AssignParams): Promise<AssignResultDto>
    {
        const [engine, snapshot] = await this.host.Settled()
        const catalog = snapshot.SchemaCatalog
        if (RecordGrants.IsExternal(snapshot.Catalog.Identity, params.id)) return { status: AssignStatus.Invalid, reason: RecordGrants.ExternalRecordReason }
        const tier1 = await this.tier1()
        const model = await tier1.Model()
        const scope = await (await this.scopes()).ScopeFor(context)
        const concept = await EnvironmentAssignService.ConceptOf(engine, scope.Scope, params, catalog)
        if (concept === undefined) return { status: AssignStatus.NotFound, reason: EnvironmentAssignService.RecordNotFound }
        const security = snapshot.Catalog.Security
        const evaluator = AccessDepthEvaluator.For(security, model, Tier1Catalog.EngineStoredConcepts(snapshot.Catalog))
        const computed = evaluator.AssignWrites(context.Tenant.Id, concept, params.owner.id, params.owner.kind === ShareSubjectKind.Team, params.owningBu)
        if (computed.outcome === AssignOutcome.Unsupported) return { status: AssignStatus.Invalid, reason: EnvironmentAssignService.OrganizationOwnedReason }
        const grants = await tier1.Grants(context, snapshot)
        const base = await tier1.AssignRecords(context, snapshot)
        const transaction = await engine.Begin(AssignScope.For(base, concept, params.id, EnvironmentAssignService.SystemFields, catalog))
        try
        {
            const view = await RecordGrants.View(transaction, params.id, concept, catalog)
            if (view === undefined || view.Concept !== concept) return { status: AssignStatus.NotFound, reason: EnvironmentAssignService.RecordNotFound }
            const allowed = await RecordGrants.Covers(engine, grants, PrivilegeAction.Assign, concept, params.id)
                || await RecordGrants.Holds(transaction, params.id, RecordGrants.Subjects(context, model), ShareRight.Assign)
            if (!allowed) return { status: AssignStatus.Denied, reason: EnvironmentAssignService.NotAuthorized }
            const rejection = EnvironmentAssignService.StatusFor(computed.outcome)
            if (rejection !== undefined) return rejection
            await new OwnershipAssignment(security.OwnedConcepts()).Assign(transaction, params.id, EnvironmentAssignService.OwnerOf(computed.writes))
            return await EnvironmentAssignService.Commit(transaction)
        }
        finally
        {
            transaction.dispose()
        }
    }

    /** The owner AssignWrites gives (its two system-field writes) as OwnershipAssignment takes it. */
    private static OwnerOf(writes: readonly { field: string; value: string }[]): IOwnerAssignment
    {
        const value = (field: string): string => writes.find(write => write.field === field)?.value ?? EnvironmentAssignService.NoValue
        return { OwnerId: value(SystemNames.Owner), BusinessUnitId: value(SystemNames.OwningBusinessUnit) }
    }

    /** The record's concept as the caller's scope sees it, when it is `params.concept` or a subconcept. */
    private static async ConceptOf(engine: GraphEngine, scope: AccessScope, params: AssignParams, catalog: EngineSchemaCatalog): Promise<string | undefined>
    {
        const reader = await engine.BeginRead(scope)
        try
        {
            return (await RecordGrants.View(reader, params.id, params.concept, catalog))?.Concept
        }
        finally
        {
            reader.dispose()
        }
    }

    private static StatusFor(outcome: AssignOutcome): AssignResultDto | undefined
    {
        switch (outcome)
        {
            case AssignOutcome.UnknownTeam:
                return { status: AssignStatus.Invalid, reason: EnvironmentAssignService.UnknownTeam }
            case AssignOutcome.UnknownBusinessUnit:
                return { status: AssignStatus.Invalid, reason: EnvironmentAssignService.UnknownBusinessUnit }
            case AssignOutcome.OwningBusinessUnitRequired:
                return { status: AssignStatus.Invalid, reason: EnvironmentAssignService.OwningBuRequired }
            default:
                return undefined
        }
    }

    private static async Commit(transaction: GraphTransaction): Promise<AssignResultDto>
    {
        try
        {
            await transaction.Commit()
        }
        catch (error)
        {
            const outcome = EngineWriteFailure.Map(error)
            if (outcome === undefined) throw error
            return { status: AssignStatus.Denied, reason: outcome.Status === AppWriteStatus.Conflict ? EngineWriteFailure.WriteConflict : EngineWriteFailure.WriteFailed }
        }
        return { status: AssignStatus.Applied }
    }
}
