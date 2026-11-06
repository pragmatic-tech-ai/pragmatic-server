import type { AuditRecord, AuditRegistry } from '../audit-record.js'
import type { TenantSession } from './tenant-session.js'

/** What a tenant-plane caller records; `at` is stamped on append. */
export type TenantAuditFields = Omit<AuditRecord, 'id' | 'at'>

/**
 * The one home for how tenant-plane actions (desktop relays, graph writes) reach an audit log: who the actor is, how long a
 * field may be, and that an append is best effort. A failed append never changes the caller's answer and logs only the
 * error's name, so no path, note or actor (an email) ever reaches the log.
 */
export class TenantAuditEntry
{
    public static readonly MaxField = 128
    private static readonly ActorSeparator = '/'
    private static readonly LogPrefix = '[tenant-audit] audit append failed:'

    /** `tenantId/email`, or `tenantId/principalId` when the session carries no email. */
    public static ActorOf(session: TenantSession): string
    {
        return session.tenantId + TenantAuditEntry.ActorSeparator + (session.email ?? session.principalId)
    }

    public static Clip(text: string): string
    {
        return text.length > TenantAuditEntry.MaxField ? text.slice(0, TenantAuditEntry.MaxField) : text
    }

    /** Appends `fields` with every text field clipped and `at` stamped now; never throws. */
    public static async AppendBestEffort(audit: AuditRegistry, fields: TenantAuditFields): Promise<void>
    {
        const C = TenantAuditEntry
        const entry = { actor: C.Clip(fields.actor), method: C.Clip(fields.method), path: C.Clip(fields.path), status: fields.status, at: new Date().toISOString() }
        try
        {
            await audit.Append(fields.note === undefined ? entry : { ...entry, note: C.Clip(fields.note) })
        }
        catch (err)
        {
            console.error(C.LogPrefix, err instanceof Error ? err.name : typeof err)
        }
    }
}
