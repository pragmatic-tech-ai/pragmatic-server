import { randomUUID } from 'node:crypto'
import { JsonRecordStore } from './json-record-store.js'

export type LedgerAction = 'gated' | 'ungated' | 'withdrawn' | 'restored' | 'selected' | 'adopted'

export type AdoptionLedgerRecord = {
    id: string
    tenantId?: string
    hiveId?: string
    version: string
    action: LedgerAction
    at: string
}

/** Append-only version-change timeline emitted by the deployment registry; bounded to the newest MaxEntries. */
export class AdoptionLedgerRegistry extends JsonRecordStore<AdoptionLedgerRecord>
{
    private static readonly RootKey = 'adoptionLedger'
    private static readonly MaxEntries = 2000
    private static readonly WithdrawnAction: LedgerAction = 'withdrawn'
    private static readonly RestoredAction: LedgerAction = 'restored'

    public constructor(filePath: string)
    {
        super(filePath, AdoptionLedgerRegistry.RootKey)
    }

    public async Append(entry: Omit<AdoptionLedgerRecord, 'id' | 'at'>): Promise<void>
    {
        await this.Put({ ...entry, id: randomUUID(), at: new Date().toISOString() })
        const all = this.List()
        if (all.length <= AdoptionLedgerRegistry.MaxEntries)
        {
            return
        }
        const excess = all.length - AdoptionLedgerRegistry.MaxEntries
        const oldest = [...all].sort((a, b) => a.at.localeCompare(b.at)).slice(0, excess)
        for (const rec of oldest)
        {
            await this.Remove(rec.id)
        }
    }

    public ForHive(hiveId: string, limit: number): readonly AdoptionLedgerRecord[]
    {
        return this.Newest(r => r.hiveId === hiveId, limit)
    }

    public ForTenant(tenantId: string, limit: number): readonly AdoptionLedgerRecord[]
    {
        return this.Newest(r => r.tenantId === tenantId, limit)
    }

    /** Tenant-scoped events plus global withdrawn/restored events, only for versions this tenant encountered. */
    public ForTenantIncludingVersionEvents(tenantId: string, limit: number): readonly AdoptionLedgerRecord[]
    {
        const all = this.List()
        const tenantRecs = all.filter(r => r.tenantId === tenantId)
        const tenantVersions = new Set(tenantRecs.map(r => r.version))
        const versionRecs = all.filter(r => r.tenantId === undefined && r.hiveId === undefined
            && (r.action === AdoptionLedgerRegistry.WithdrawnAction || r.action === AdoptionLedgerRegistry.RestoredAction)
            && tenantVersions.has(r.version))
        return [...tenantRecs, ...versionRecs].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
    }

    private Newest(match: (r: AdoptionLedgerRecord) => boolean, limit: number): readonly AdoptionLedgerRecord[]
    {
        return this.List().filter(match).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
    }
}
