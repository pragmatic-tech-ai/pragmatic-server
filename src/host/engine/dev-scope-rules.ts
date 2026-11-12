import { AccessDefault, AccessScope, GraphError, GraphErrorCode } from '@pragmatic-tech-ai/graph'
import type { Cypher, ISignal } from '@pragmatic-tech-ai/graph'
import { TodlNodePlacement } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { VoidSignal } from './access-scope-source.js'
import type { IPreparedRules, IScopeRecords, IScopeRules, ScopeSchema } from './access-scope-source.js'
import { PrincipalFacts } from './principal-facts.js'
import { SavedMemberReader } from './saved-member-reader.js'

/** The dev rules against one schema: an unrestricted record part, no finish, TODL placement. */
class DevPreparedRules implements IPreparedRules
{
    private static readonly MissingModelMessage = 'a dev create needs the model it is placed in'
    private static readonly Unrestricted: IScopeRecords = { Scope: AccessScope.Build({ Default: AccessDefault.Allow }), Diagnostics: [], Principal: PrincipalFacts.None }
    private static readonly NoDigest = ''

    public readonly Digest = DevPreparedRules.NoDigest

    public constructor(private readonly solutionName: string | undefined)
    {
    }

    public Records(_context: AccessContext): Promise<IScopeRecords>
    {
        return Promise.resolve(DevPreparedRules.Unrestricted)
    }

    public Finish(scope: AccessScope, _context: AccessContext): Promise<AccessScope>
    {
        return Promise.resolve(scope)
    }

    public Placement(_principal: PrincipalFacts, modelId: string | undefined): Cypher.INodePlacement
    {
        if (modelId === undefined) throw new GraphError(GraphErrorCode.InvalidArgument, DevPreparedRules.MissingModelMessage)
        // a model id with no namespace prefix falls back to the solution name (as the dev draft does), else to itself
        const namespace = SavedMemberReader.NamespaceOf(modelId, this.solutionName ?? modelId)
        return new TodlNodePlacement(modelId, namespace)
    }
}

/**
 * The dev tenant's scope rules (AccessScopeSource; spec §5.1, program ruling PR13): authoring data is governed by the
 * identity RBAC at the `PolicyGate` only, so the record part is `AccessScope.Build({ Default: Allow })` for every
 * principal the gate admits, with or without identity; the environment security setting is never read (a Development
 * tenant refuses one). The model confinement of a model-scoped read or write (`OwnerIs(modelId)`) is applied by its
 * endpoint, unchanged. `Finish` is the identity; placement is TODL's (the model's namespace, the model as owner), and a
 * create with no model is InvalidArgument. `Changed` never fires: the source drops its scopes on the host's Changed.
 */
export class DevScopeRules implements IScopeRules
{
    public readonly Changed: ISignal<void> = new VoidSignal()

    public constructor(private readonly solutionName: () => Promise<string | undefined> = () => Promise.resolve(undefined))
    {
    }

    public async Prepare(_schema: ScopeSchema): Promise<IPreparedRules>
    {
        return new DevPreparedRules(await this.solutionName())
    }

    public dispose(): void
    {
    }
}
