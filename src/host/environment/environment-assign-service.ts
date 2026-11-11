import type { AccessScope, GraphEngine, GraphTransaction } from '@pragmatic-tech-ai/graph'
import { ShareRight } from '@pragmatic-tech-ai/todl/engine'
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { AssignOutcome } from '@pragmatic-tech-ai/todl-identity-engine'
import { AppWriteStatus, AssignStatus, ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AssignParams, AssignResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IGraphScopeSource, ITenantSecuritySource } from '../engine/access-scope-source.js'
import type { EngineSchemaCatalog } from '../engine/engine-schema-catalog.js'
import { EngineWriteFailure } from '../engine/engine-write-failure.js'
import type { EnvironmentEngineHost } from './environment-engine-host.js'
import { RecordGrants } from './record-grants.js'
import { AssignScope } from './service-scopes.js'

/**
 * Record assign on the environment engine (ruling S9, amendment A4): changes a record's ownership members under the
 * Assign right, bypassing the Update gate (as before) and writing nothing else.
 *
 * - The record's concept is read under the caller's scope first (absent, invisible or not `params.concept` or a
 *   subconcept: `not-found`); `evaluator.AssignWrites(concept, owner, isTeam, owningBu)` gives the ownership writes
 *   (only those that are properties of the concept are kept).
 * - Then ONE transaction under `AssignScope.For(callerScope, concept, id, ownership members)` reads the record again
 *   (recorded, so a concurrent change conflicts) and authorizes: `Allows(principal, Assign, view)` or one of the
 *   caller's grants on the record holds `assign`, else `denied` (`not-found` if the record is no longer visible). The
 *   AssignWrites outcome then maps as before (`unsupported`, `invalid` unknown team / business unit / owning BU
 *   required); no ownership member left: `invalid` "no ownership columns to write". The writes are `SetProperty` on
 *   the record; the engine refuses any other member (AssignScope's ReadOnlyExact).
 * - Commit: a conflict (ConflictError, or an external conflict) is `denied` "write conflict"; any other mapped failure
 *   `denied` "write failed"; an error outside EngineWriteFailure propagates (InternalError).
 * - An external record (A4) is `invalid` "external records are outside platform security".
 *
 * Narrowing (as R41 for data/write): an Assign-only share on a record the caller cannot read no longer authorizes; the
 * record must be visible to the caller.
 */
export class EnvironmentAssignService
{
    private static readonly RecordNotFound = 'record not found or not visible'
    private static readonly NotAuthorized = 'not authorized to assign this record'
    private static readonly NotAssignable = 'concept is not assignable'
    private static readonly OwningBuRequired = 'an owning business unit is required'
    private static readonly UnknownBusinessUnit = 'unknown owning business unit'
    private static readonly UnknownTeam = 'unknown team owner'
    private static readonly NoOwnershipColumns = 'no ownership columns to write'

    public constructor(
        private readonly host: EnvironmentEngineHost,
        private readonly scopes: () => Promise<IGraphScopeSource>,
        private readonly security: () => Promise<ITenantSecuritySource>)
    {
    }

    public async Assign(context: AccessContext, params: AssignParams): Promise<AssignResultDto>
    {
        const [engine, snapshot] = await this.host.Settled()
        const catalog = snapshot.SchemaCatalog
        if (RecordGrants.IsExternal(snapshot.Catalog.Identity, params.id)) return { status: AssignStatus.Invalid, reason: RecordGrants.ExternalRecordReason }
        const evaluator = await (await this.security()).EvaluatorForContext(context)
        const scope = await (await this.scopes()).ScopeFor(context)
        const concept = await EnvironmentAssignService.ConceptOf(engine, scope.Scope, params, catalog)
        if (concept === undefined) return { status: AssignStatus.NotFound, reason: EnvironmentAssignService.RecordNotFound }
        const computed = evaluator.AssignWrites(concept, params.owner.id, params.owner.kind === ShareSubjectKind.Team, params.owningBu)
        const writes = computed.writes.filter(write => catalog.IsProperty(concept, write.field))
        const transaction = await engine.Begin(AssignScope.For(scope.Scope, concept, params.id, new Set(writes.map(write => write.field)), catalog))
        try
        {
            const view = await RecordGrants.View(transaction, params.id, concept, catalog)
            if (view === undefined || view.Concept !== concept) return { status: AssignStatus.NotFound, reason: EnvironmentAssignService.RecordNotFound }
            const allowed = evaluator.Allows(context.Principal, PrivilegeAction.Assign, view)
                || await RecordGrants.Holds(transaction, params.id, RecordGrants.Subjects(context, evaluator), ShareRight.Assign)
            if (!allowed) return { status: AssignStatus.Denied, reason: EnvironmentAssignService.NotAuthorized }
            const rejection = EnvironmentAssignService.StatusFor(computed.outcome)
            if (rejection !== undefined) return rejection
            if (writes.length === 0) return { status: AssignStatus.Invalid, reason: EnvironmentAssignService.NoOwnershipColumns }
            for (const write of writes) transaction.SetProperty(params.id, write.field, write.value)
            return await EnvironmentAssignService.Commit(transaction)
        }
        finally
        {
            transaction.dispose()
        }
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
            case AssignOutcome.Unsupported:
                return { status: AssignStatus.Unsupported, reason: EnvironmentAssignService.NotAssignable }
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
