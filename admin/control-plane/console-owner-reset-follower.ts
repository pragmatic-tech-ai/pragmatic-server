import { readFile } from 'node:fs/promises'
import { AtomicJsonFile, SerialRuns } from './atomic-json-file.js'
import { OwnerResetTime, TenantOwner, type OwnedTenant } from './tenant-owner.js'

/**
 * What the follower ends: every session of a principal, console and desktop, with its open sockets and desktop relays
 * (TenantPrincipalSessions.RevokeAllFor, which closes them even when the session store write fails, then rethrows).
 */
export interface IOwnerSessionEnder
{
    RevokeAllFor(tenantId: string, principalId: string): Promise<void>
}

/**
 * The in-hive console's side of an operator Owner reset. The control plane answers each advert with the tenant's last reset
 * time; when that value is well formed and differs from the one this console last applied (or none was), the follower ends
 * every session of the Owner (console cookies and desktop bearers) and closes its sockets and relays, then records the value
 * in `<dataRoot>/owner-reset-applied.json` (`{ appliedAt }`, temp file + unique name + rename). The marker is written only
 * after the revoke resolved, so a failed revoke is retried on the next advert; an unreadable marker counts as none (one extra
 * revoke, never a missed one). Any difference counts, not only a later time, so a control-plane clock that moved back still
 * ends the sessions. A session the Owner opened between the reset and the advert ends too.
 * Once the revoke resolved the value counts as applied in memory, so a marker write that fails is reported (the caller logs
 * it) without signing the Owner out again at later adverts of this process; only a restart, finding no durable marker,
 * revokes once more (never a missed reset). A failed revoke itself leaves the value unapplied and is retried at every advert.
 * Kept free of control-plane imports: only the Owner rules (tenant-owner.ts), the atomic file write (atomic-json-file.ts)
 * and node built-ins.
 */
export class ConsoleOwnerResetFollower
{
    public static readonly FileName = 'owner-reset-applied.json'
    private static readonly AppliedKey = 'appliedAt'
    private static readonly Utf8 = 'utf8'

    /** The applied value once read or written; undefined until the marker is first read. */
    private applied: { value: string | undefined } | undefined
    private readonly runs = new SerialRuns()

    public constructor(
        private readonly principals: IOwnerSessionEnder,
        private readonly tenant: OwnedTenant,
        private readonly path: string)
    {
    }

    /**
     * Ends the Owner's sessions when `resetAt` is well formed and differs from the applied marker (or there is none), then
     * records it; returns whether it revoked. Undefined or malformed values are ignored. Calls run one at a time.
     */
    public Apply(resetAt: string | undefined): Promise<boolean>
    {
        return this.runs.Run(() => this.ApplyNow(resetAt))
    }

    private async ApplyNow(resetAt: string | undefined): Promise<boolean>
    {
        if (!OwnerResetTime.IsWellFormed(resetAt))
        {
            return false
        }
        if (await this.AppliedValue() === resetAt)
        {
            return false
        }
        await this.principals.RevokeAllFor(this.tenant.id, TenantOwner.PrincipalOf(this.tenant))
        // Applied once the revoke resolved: a marker write that fails is still reported, but signs nobody out again here.
        this.applied = { value: resetAt }
        await this.WriteMarker(resetAt)
        return true
    }

    private async AppliedValue(): Promise<string | undefined>
    {
        if (this.applied === undefined)
        {
            this.applied = { value: await this.ReadMarker() }
        }
        return this.applied.value
    }

    private async ReadMarker(): Promise<string | undefined>
    {
        try
        {
            const body = JSON.parse(await readFile(this.path, ConsoleOwnerResetFollower.Utf8)) as unknown
            const value = body !== null && typeof body === 'object' && !Array.isArray(body)
                ? (body as Record<string, unknown>)[ConsoleOwnerResetFollower.AppliedKey]
                : undefined
            return typeof value === 'string' ? value : undefined
        }
        catch
        {
            return undefined
        }
    }

    private WriteMarker(value: string): Promise<void>
    {
        return AtomicJsonFile.Write(this.path, { [ConsoleOwnerResetFollower.AppliedKey]: value })
    }
}
