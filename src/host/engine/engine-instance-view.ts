import type { CellValue, GraphReader, INodeView } from '@pragmatic-tech-ai/graph'
import type { IInstanceView, Scalar } from '@pragmatic-tech-ai/todl'

/**
 * One engine node as the tenant security model's evaluator judges it (`AccessDepthEvaluator.Allows`): its concept and
 * its scalar property values as the reader sees them. A String, Float64 or Boolean value reads as itself, an Int64 as a
 * number when it is a safe integer and as its decimal text otherwise; an unset value and a temporal value read as
 * undefined, so a rule on them fails closed. Built from `GraphReader.ReadNode`, so a node the reader's scope hides is
 * no view at all and a hidden member is absent.
 */
export class EngineInstanceView implements IInstanceView
{
    private constructor(private readonly node: INodeView)
    {
    }

    /** The view of `publicId` under `reader`'s scope; undefined when the node does not exist or is not visible. */
    public static async Of(reader: GraphReader, publicId: string): Promise<EngineInstanceView | undefined>
    {
        const node = await reader.ReadNode(publicId)
        return node === undefined ? undefined : new EngineInstanceView(node)
    }

    public get Concept(): string
    {
        return this.node.Concept
    }

    public Field(name: string): Scalar | undefined
    {
        return EngineInstanceView.ScalarOf(this.node.Properties.get(name))
    }

    private static ScalarOf(value: CellValue | undefined): Scalar | undefined
    {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
        if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
        return undefined
    }
}
