import { randomUUID } from 'node:crypto'
import { JsonRecordStore } from './json-record-store.js'

export type AuditRecord = {
    id: string
    actor: string
    method: string
    path: string
    status: number
    at: string
}

export class AuditRegistry extends JsonRecordStore<AuditRecord>
{
    private static readonly RootKey = 'audit'
    private static readonly MaxEntries = 1000

    public constructor(filePath: string)
    {
        super(filePath, AuditRegistry.RootKey)
    }

    public async Append(entry: Omit<AuditRecord, 'id'>): Promise<void>
    {
        const id = randomUUID()
        await this.Put({ ...entry, id })
        const all = this.List()
        if (all.length <= AuditRegistry.MaxEntries)
        {
            return
        }
        const excess = all.length - AuditRegistry.MaxEntries
        const oldest = [...all].sort((a, b) => a.at.localeCompare(b.at)).slice(0, excess)
        for (const rec of oldest)
        {
            await this.Remove(rec.id)
        }
    }

    public Recent(limit: number): readonly AuditRecord[]
    {
        return [...this.List()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
    }
}
