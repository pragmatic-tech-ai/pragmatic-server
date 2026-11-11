import { AccessError, ConnectorError } from '@pragmatic-tech-ai/graph'
import type { CellValue, GraphTransaction, IFetchKey } from '@pragmatic-tech-ai/graph'
import { EngineBridgeErrorCode, ExternalWriteError } from '@pragmatic-tech-ai/todl/engine'
import type { ExternalIdentity } from '@pragmatic-tech-ai/todl/engine'

/**
 * A request's write ops as recorded on one engine transaction: which request op each recorded engine op belongs to
 * (the index an engine AccessError names), the op of each target public id (its first), and each create's id. Shared
 * by `data/write` and `connector/writePaged` / `connector/writeBack` (ruling S1).
 */
export class RecordedBatch
{
    public readonly Placed: (string | undefined)[] = []
    private readonly opOfBatch: number[] = []
    private readonly opOfId = new Map<string, number>()

    public constructor(private readonly transaction: GraphTransaction)
    {
    }

    public CreateNode(op: number, publicId: string, concept: string, owner: string | undefined): void
    {
        this.Target(op, publicId)
        this.Placed[op] = publicId
        this.transaction.CreateNode(publicId, concept, owner === undefined ? undefined : { Owner: owner })
        this.opOfBatch.push(op)
    }

    public SetProperty(op: number, publicId: string, member: string, value: CellValue): void
    {
        this.transaction.SetProperty(publicId, member, value)
        this.opOfBatch.push(op)
    }

    public SetDefault(op: number, publicId: string, member: string, value: CellValue): void
    {
        this.transaction.SetDefault(publicId, member, value)
        this.opOfBatch.push(op)
    }

    public DeleteNode(op: number, publicId: string): void
    {
        this.Target(op, publicId)
        this.transaction.DeleteNode(publicId)
        this.opOfBatch.push(op)
    }

    /** Records `publicId` as `op`'s target when no earlier op targets it. */
    public Target(op: number, publicId: string): void
    {
        if (!this.opOfId.has(publicId)) this.opOfId.set(publicId, op)
    }

    /** The request op of the recorded engine op at `index`, else the first op targeting `publicId`. */
    public OpOf(index: number | undefined, publicId: string | undefined): number | undefined
    {
        const byIndex = index === undefined ? undefined : this.opOfBatch[index]
        if (byIndex !== undefined) return byIndex
        return publicId === undefined ? undefined : this.opOfId.get(publicId)
    }
}

/**
 * How a host write keys its fetches and names the op a commit failure is about (rulings R15, R38): shared by every
 * engine write that records ops on a {@link RecordedBatch}.
 */
export class EngineWriteAttribution
{
    /** An engine AccessError: "Access denied: op N (Op) on '<id>' (<concept>): <reason>" (N the recorded op index). */
    private static readonly DeniedPattern = /^Access denied: op (\d+) \(\w+\) on '(.*?)' \(/s

    private constructor()
    {
    }

    /** An external id is fetched as its binding's concept and model (TODL ids are opaque to the engine); any other by id. */
    public static FetchKey(id: string, identity: ExternalIdentity | undefined): IFetchKey
    {
        const parsed = identity?.Parse(id)
        return parsed === undefined ? { PublicId: id } : { PublicId: id, Concept: parsed.Binding.Binding.Concept, Owner: parsed.Binding.Model }
    }

    /**
     * The op a commit failure names, else undefined (unattributed): an AccessError names the recorded engine op index
     * (mapped to its request op) and the public id (the fallback); an ExternalWriteFailed names the row
     * (`ExternalIdentity.Mint(binding, key)`). Anything else (a CommitError, an Apply-phase refusal, a CompensationFailed,
     * a failed revert) is unattributed.
     */
    public static Attribute(error: unknown, identity: ExternalIdentity | undefined, batch: RecordedBatch): number | undefined
    {
        if (error instanceof AccessError)
        {
            const denied = EngineWriteAttribution.DeniedPattern.exec(error.message)
            return denied === null ? undefined : batch.OpOf(Number(denied[1]), denied[2])
        }
        if (identity === undefined || !(error instanceof ConnectorError) || !(error.cause instanceof ExternalWriteError)) return undefined
        const cause = error.cause
        const failure = cause.Failures[0]
        if (cause.Code !== EngineBridgeErrorCode.ExternalWriteFailed || failure === undefined || failure.Key === null) return undefined
        // a placed id was minted from the id member's text (EnvironmentNodePlacement: String of a bigint / number / string)
        return batch.OpOf(undefined, identity.Mint(cause.Binding, String(failure.Key)))
    }
}
