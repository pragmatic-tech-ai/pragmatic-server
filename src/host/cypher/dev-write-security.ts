import type { IInstanceFilter, Repository, Cypher } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { Action } from '@pragmatic-tech-ai/todl-identity'
import { IdentityEnforcement, CompositeInstanceFilter } from '@pragmatic-tech-ai/todl-identity-engine'
import { FilteredGraphQuery } from './filtered-graph-query.js'
import { FieldMaskedGraphQuery, AllowAllFieldReadMask } from './field-masked-graph-query.js'
import type { IFieldReadMask } from './field-masked-graph-query.js'
import { AllowAllWriteInstanceGate } from './write-instance-gate.js'
import type { IWriteInstanceGate } from './write-instance-gate.js'
import { DevWriteTargetSource } from './dev-write-target-source.js'
import { NoopDraftGraphMask } from '../model/dev-model-writer.js'
import type { IDraftGraphMask } from '../model/dev-model-writer.js'
import type { TenantReadAuthorization } from './read-filter-source.js'

/** The security a dev Cypher write runs under: the read mask over the draft and the per-instance write gate. */
export interface IDevWriteSecurity
{
    readonly Mask: IDraftGraphMask
    GateFor(repo: Repository, maskedGraph: Cypher.ICypherGraph): Promise<IWriteInstanceGate>
}

/** No identity subsystem: nothing is masked and every write is allowed. */
export class OpenDevWriteSecurity implements IDevWriteSecurity
{
    public readonly Mask: IDraftGraphMask = NoopDraftGraphMask.Instance

    public async GateFor(): Promise<IWriteInstanceGate>
    {
        return AllowAllWriteInstanceGate.Instance
    }
}

/** The SAME decorators the SP3 read path uses (row filter, then field mask), applied to a draft bake. */
export class PrincipalDraftGraphMask implements IDraftGraphMask
{
    constructor(private readonly context: AccessContext, private readonly depth: IInstanceFilter, private readonly fields: IFieldReadMask)
    {
    }

    public Apply(query: IGraphQuery, repo: Repository): IGraphQuery
    {
        const predicate = IdentityEnforcement.ForRepository(repo, this.context, Action.Read).InstanceFilter()
        const filtered = new FilteredGraphQuery(query, new CompositeInstanceFilter([predicate, this.depth]))
        return this.fields === AllowAllFieldReadMask.Instance ? filtered : new FieldMaskedGraphQuery(filtered, this.fields)
    }
}

/** Per-principal security: masked reads over the draft, write gate keyed to the principal's Write depth. */
export class PrincipalDevWriteSecurity implements IDevWriteSecurity
{
    public readonly Mask: IDraftGraphMask

    private constructor(private readonly context: AccessContext, private readonly auth: TenantReadAuthorization, mask: IDraftGraphMask)
    {
        this.Mask = mask
    }

    public static async For(context: AccessContext, auth: TenantReadAuthorization): Promise<PrincipalDevWriteSecurity>
    {
        const depth = await auth.ReadFilterFor(context)
        const fields = await auth.FieldReadMaskFor(context)
        return new PrincipalDevWriteSecurity(context, auth, new PrincipalDraftGraphMask(context, depth, fields))
    }

    public async GateFor(repo: Repository, maskedGraph: Cypher.ICypherGraph): Promise<IWriteInstanceGate>
    {
        const predicate = IdentityEnforcement.ForRepository(repo, this.context, Action.Write).InstanceFilter()
        return this.auth.WriteInstanceGateFor(this.context, predicate, new DevWriteTargetSource(maskedGraph))
    }
}
