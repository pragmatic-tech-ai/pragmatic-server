import { Resolver } from 'node:dns/promises'
import { DomainVerificationRecord } from './domain-verification-record.js'

/** How one TXT lookup ended: records found, the name has no TXT record, or the lookup could not be completed. */
export enum TxtLookupStatus
{
    Found = 'found',
    NoRecord = 'no-record',
    Failed = 'failed',
}

/** One TXT lookup's outcome; `records` holds each record's character-strings and is empty unless Found. */
export type TxtLookup = { status: TxtLookupStatus; records: string[][] }

/** Looks up the TXT records at a name. Never throws: every failure, including a hang past the deadline, answers Failed. */
export interface ITxtResolver
{
    ResolveTxt(name: string): Promise<TxtLookup>
}

/** The slice of `node:dns/promises` Resolver the lookup uses (camelCase because the real Resolver satisfies it as is). */
export interface IDnsTxtBackend
{
    resolveTxt(name: string): Promise<string[][]>
    cancel(): void
}

/**
 * ITxtResolver over node's DNS resolver. Every lookup gets its own backend from the factory, because Resolver.cancel() cancels
 * every outstanding query on that instance: one lookup hitting the hard deadline must not fail the others. The backend's own
 * timeout/tries bound each attempt; the hard deadline bounds the whole lookup, cancels that lookup's backend and answers Failed.
 */
export class NodeTxtResolver implements ITxtResolver
{
    private static readonly AttemptTimeoutMs = 3000
    private static readonly AttemptTries = 2
    private static readonly DeadlineMs = 10000
    private static readonly NoDataCode = 'ENODATA'
    private static readonly NotFoundCode = 'ENOTFOUND'

    public constructor(
        private readonly backends: () => IDnsTxtBackend = NodeTxtResolver.NewBackend,
        private readonly deadlineMs: number = NodeTxtResolver.DeadlineMs,
    )
    {
    }

    public async ResolveTxt(name: string): Promise<TxtLookup>
    {
        let backend: IDnsTxtBackend
        let pending: Promise<string[][]>
        try
        {
            backend = this.backends()
            pending = backend.resolveTxt(name)
        }
        catch
        {
            return NodeTxtResolver.LookupOf(TxtLookupStatus.Failed)
        }
        // Both handlers are attached up front, so a lookup abandoned at the deadline (late ECANCELLED) is never unhandled.
        const lookup = pending.then(
            records => NodeTxtResolver.LookupOf(TxtLookupStatus.Found, records),
            (error: unknown) => NodeTxtResolver.LookupOf(NodeTxtResolver.StatusOf(error)),
        )
        let timer: NodeJS.Timeout | undefined
        const deadline = new Promise<TxtLookup>(resolve =>
        {
            timer = setTimeout(() => resolve(NodeTxtResolver.Abandon(backend)), this.deadlineMs)
        })
        try
        {
            return await Promise.race([lookup, deadline])
        }
        finally
        {
            clearTimeout(timer)
        }
    }

    private static NewBackend(): IDnsTxtBackend
    {
        return new Resolver({ timeout: NodeTxtResolver.AttemptTimeoutMs, tries: NodeTxtResolver.AttemptTries })
    }

    /** Cancels the one backend whose lookup ran past the deadline; a throwing cancel still answers Failed. */
    private static Abandon(backend: IDnsTxtBackend): TxtLookup
    {
        try
        {
            backend.cancel()
        }
        catch
        {
            // The lookup is answered Failed either way.
        }
        return NodeTxtResolver.LookupOf(TxtLookupStatus.Failed)
    }

    private static StatusOf(error: unknown): TxtLookupStatus
    {
        const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
        return code === NodeTxtResolver.NoDataCode || code === NodeTxtResolver.NotFoundCode ? TxtLookupStatus.NoRecord : TxtLookupStatus.Failed
    }

    private static LookupOf(status: TxtLookupStatus, records: string[][] = []): TxtLookup
    {
        return { status, records }
    }
}

/** What one domain's TXT check found: our record, no record at all, only other records, or no answer. */
export enum DomainCheck
{
    Verified = 'verified',
    Absent = 'absent',
    Mismatch = 'mismatch',
    Failed = 'failed',
}

/** Checks whether a domain publishes the TXT record carrying a tenant's token. */
export class DomainTxtVerifier
{
    public constructor(private readonly resolver: ITxtResolver)
    {
    }

    /** Looks up `_pragmatic-verification.<normalised domain>` and compares every record against `token`'s value. */
    public async Check(domain: string, token: string): Promise<DomainCheck>
    {
        const lookup = await this.resolver.ResolveTxt(DomainVerificationRecord.NameFor(domain))
        switch (lookup.status)
        {
            case TxtLookupStatus.Found:
                return DomainVerificationRecord.Matches(lookup.records, token) ? DomainCheck.Verified : DomainCheck.Mismatch
            case TxtLookupStatus.NoRecord:
                return DomainCheck.Absent
            default:
                return DomainCheck.Failed
        }
    }
}
