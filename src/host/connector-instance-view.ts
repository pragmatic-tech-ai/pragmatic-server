import type { ConnectorBinding, ExternalRecord, IInstanceView, Scalar } from '@pragmatic-tech-ai/todl'

/** Adapts ONE raw connector record to an IInstanceView. Members resolve to external columns ONLY through the binding's
 *  FieldMap (member -> column); an unmapped member is undefined (no raw-member fallback), so a rule on it fails closed. */
export class ConnectorInstanceView implements IInstanceView
{
    private readonly binding: ConnectorBinding
    private readonly record: ExternalRecord

    public constructor(binding: ConnectorBinding, record: ExternalRecord)
    {
        this.binding = binding
        this.record = record
    }

    public get Concept(): string
    {
        return this.binding.Concept
    }

    /** Fail closed: a member NOT in binding.FieldMap is undefined, so a security rule on an unmapped member never reads a stray column or the raw member name. */
    public Field(name: string): Scalar | undefined
    {
        const column = Object.hasOwn(this.binding.FieldMap, name) ? this.binding.FieldMap[name] : undefined
        if (column === undefined)
        {
            return undefined
        }
        return (this.record[column] ?? undefined) as Scalar | undefined
    }
}
