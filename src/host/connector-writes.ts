import type { ConnectorBinding, ExternalFieldValue } from '@pragmatic-tech-ai/todl'

/** Maps model member fields to external connector columns via a binding's field map, dropping the id key. */
export class ConnectorWrites
{
    public static ToExternalFields(binding: ConnectorBinding, fields: Record<string, unknown> | undefined): Record<string, ExternalFieldValue>
    {
        const out: Record<string, ExternalFieldValue> = {}
        const payload = fields ?? {}
        for (const member of Object.keys(payload))
        {
            const external = binding.FieldMap[member] ?? member
            if (external === binding.IdKey)
            {
                continue
            }
            out[external] = payload[member] as ExternalFieldValue
        }
        return out
    }
}
