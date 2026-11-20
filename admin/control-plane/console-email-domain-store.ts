import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import { RecordMapFormatError, RecordSlot, type IRecordMap } from './record-map.js'
import { DomainApprovalState, DomainVerificationRecord, type DomainVerificationAnswer } from './domain-verification-record.js'
import { EmailDomainPolicy, InvalidEmailDomainError } from './email-domain-policy.js'
import { DomainNotClaimedError, DomainVerificationUnavailableError, EmailDomainsNotEditableError, type ITenantEmailDomains, type TenantEmailDomainsView } from './tenant-api/tenant-email-domains.js'

/**
 * Where the console sends a Verify: the platform checks the domain's DNS TXT record and answers its verification. Throws
 * DomainNotClaimedError, DomainVerifyThrottledError or DomainVerificationUnavailableError, each with a fixed console sentence.
 */
export interface IConsoleDomainVerifyChannel
{
    VerifyDomain(domain: string): Promise<DomainVerificationAnswer>
}

/**
 * The in-hive console's own email domains: the record `domains` (a string array) of the console's database
 * (`records_console_email_domains`), or of `<dataRoot>/email-domains.json` (`{ "domains": string[] }`, the pre-A5 file the
 * importer reads). Until the Owner first saves a list, the domains are the seed's (the tenant record copied in at install),
 * filtered by EmailDomainPolicy; opening never writes. Writes are serialised (each durable when Set resolves), and `Changed`
 * fires after each write that changed the list, carrying the new list (the advert sender re-sends on it). The domains'
 * verifications come from the platform (the advert answer, or a Verify through the attached channel) and are held in memory
 * only, for the domains currently in the list.
 */
export class ConsoleEmailDomainStore implements ITenantEmailDomains
{
    public static readonly FileName = 'email-domains.json'
    /** The sentence a verify channel answers when the platform could not check the domain (or answered something unusable). */
    public static readonly PlatformUnavailableMessage = 'The platform could not check the domain. Try again later.'
    /** The record's key (and the pre-A5 file's root member). */
    public static readonly DomainsKey = 'domains'
    private static readonly MalformedPrefix = 'Invalid email domains record (expected { "domains": string[] }): '
    private static readonly NotEditableMessage = 'This console sets only its own tenant\'s email domains.'
    private static readonly NoChannelMessage = 'Domain verification is not available on this console.'
    private static readonly NotListedSuffix = ' is not among this console\'s email domains.'
    /** The adopted states that mean a domain is not in effect yet; a domain with no adopted answer has an unknown state and is not pending. */
    private static readonly PendingStates: ReadonlySet<DomainApprovalState> = new Set([DomainApprovalState.VerifiedContested, DomainApprovalState.Revoked, DomainApprovalState.Pending])

    public readonly Changed = new Signal<readonly string[]>()
    private domains: readonly string[]
    private writes: Promise<void> = Promise.resolve()
    /** The platform's latest answer per listed domain; in memory only. */
    private verifications = new Map<string, DomainVerificationAnswer>()
    private channel: IConsoleDomainVerifyChannel | undefined

    private constructor(
        private readonly slot: RecordSlot<unknown>,
        private readonly tenantId: string,
        domains: readonly string[])
    {
        this.domains = domains
    }

    /**
     * No stored list -> the seed domains (EmailDomainPolicy.Filter; refused seed entries dropped); never writes on open. A
     * malformed record (or file) throws naming its location. `location` is a record map or the path of the pre-A5 file.
     */
    public static async Open(location: string | IRecordMap<unknown>, tenantId: string, seedDomains: readonly string[] | undefined): Promise<ConsoleEmailDomainStore>
    {
        const slot = RecordSlot.Of<unknown>(location, ConsoleEmailDomainStore.DomainsKey)
        let stored: unknown
        try
        {
            stored = await slot.Read()
        }
        catch (err)
        {
            if (err instanceof RecordMapFormatError)
            {
                throw new Error(ConsoleEmailDomainStore.MalformedPrefix + slot.Location)
            }
            throw err
        }
        const domains = stored === undefined ? seedDomains ?? [] : ConsoleEmailDomainStore.DomainsIn(stored, slot.Location)
        return new ConsoleEmailDomainStore(slot, tenantId, EmailDomainPolicy.Filter(domains).accepted)
    }

    public get Domains(): readonly string[]
    {
        return this.domains
    }

    /**
     * Own tenant -> its domains, editable, with the views of the adopted verifications in list order; `pending` = the domains
     * whose adopted state is VerifiedContested, Revoked or Pending, sorted (a domain with no adopted answer is not listed: its
     * state is unknown here). Any other id -> nothing, not editable. The state is the platform's as of its last answer.
     */
    public async For(tenantId: string): Promise<TenantEmailDomainsView>
    {
        if (tenantId !== this.tenantId)
        {
            return { domains: [], editable: false, inHive: true, pending: [], verifications: [] }
        }
        const adopted = this.domains.map(d => this.verifications.get(d)).filter((a): a is DomainVerificationAnswer => a !== undefined)
        const pending = adopted.filter(a => ConsoleEmailDomainStore.PendingStates.has(a.state)).map(a => a.domain).sort()
        return { domains: [...this.domains], editable: true, inHive: true, pending, verifications: adopted.map(a => DomainVerificationRecord.ViewOf(a)) }
    }

    /**
     * Asks the platform, through the attached channel, to check one listed domain's TXT record now, holds its answer and answers
     * the updated view. Throws EmailDomainsNotEditableError (another tenant), InvalidEmailDomainError (the normalised domain is not
     * a well-formed name; checked before the list and the channel), DomainNotClaimedError (it is not listed),
     * DomainVerificationUnavailableError (no channel, or an answer for another domain) or the channel's own refusal.
     */
    public async Verify(tenantId: string, domain: string): Promise<TenantEmailDomainsView>
    {
        const S = ConsoleEmailDomainStore
        if (tenantId !== this.tenantId)
        {
            throw new EmailDomainsNotEditableError(S.NotEditableMessage)
        }
        const normalised = EmailDomainPolicy.Normalise(domain)
        const refusal = EmailDomainPolicy.CheckSyntax(normalised)
        if (refusal !== undefined)
        {
            throw new InvalidEmailDomainError(refusal)
        }
        if (!this.domains.includes(normalised))
        {
            throw new DomainNotClaimedError(normalised + S.NotListedSuffix)
        }
        if (this.channel === undefined)
        {
            throw new DomainVerificationUnavailableError(S.NoChannelMessage)
        }
        const answer = await this.channel.VerifyDomain(normalised)
        if (answer.domain !== normalised)
        {
            throw new DomainVerificationUnavailableError(S.PlatformUnavailableMessage)
        }
        // A Set may have dropped the domain while the platform answered; its answer is then not held.
        if (this.domains.includes(normalised))
        {
            this.verifications.set(normalised, answer)
        }
        return await this.For(tenantId)
    }

    /**
     * Holds, in memory only, the answers for domains currently in the list, replacing what was held before; except that a held
     * answer checked later than the incoming one for its domain is kept (an advert answer the platform computed before a Verify
     * can arrive after it, and must not show the domain's older state until the next advert).
     */
    public AdoptVerifications(answers: readonly DomainVerificationAnswer[]): void
    {
        const listed = new Set(this.domains)
        const held = this.verifications
        this.verifications = new Map(answers.filter(a => listed.has(a.domain)).map(a =>
        {
            const prior = held.get(a.domain)
            return [a.domain, prior !== undefined && ConsoleEmailDomainStore.CheckedLater(prior, a) ? prior : a]
        }))
    }

    /** Where Verify sends a domain to be checked (the console's agent channel to the platform). */
    public AttachVerifyChannel(channel: IConsoleDomainVerifyChannel): void
    {
        this.channel = channel
    }

    /** Throws EmailDomainsNotEditableError (another tenant) or InvalidEmailDomainError (before anything is written). */
    public async Set(tenantId: string, domains: unknown): Promise<TenantEmailDomainsView>
    {
        if (tenantId !== this.tenantId)
        {
            throw new EmailDomainsNotEditableError(ConsoleEmailDomainStore.NotEditableMessage)
        }
        const parsed = EmailDomainPolicy.Parse(domains)
        const run = this.writes.then(() => this.Apply(parsed))
        this.writes = run.catch(() => undefined)
        await run
        return await this.For(tenantId)
    }

    private static DomainsIn(stored: unknown, location: string): string[]
    {
        if (!Array.isArray(stored) || !stored.every(d => typeof d === 'string'))
        {
            throw new Error(ConsoleEmailDomainStore.MalformedPrefix + location)
        }
        return stored as string[]
    }

    /** True when `a` was checked after `b` (an answer never checked is the oldest). */
    private static CheckedLater(a: DomainVerificationAnswer, b: DomainVerificationAnswer): boolean
    {
        if (a.lastCheckedAt === undefined)
        {
            return false
        }
        return b.lastCheckedAt === undefined || Date.parse(a.lastCheckedAt) > Date.parse(b.lastCheckedAt)
    }

    private static SameList(a: readonly string[], b: readonly string[]): boolean
    {
        return a.length === b.length && a.every((d, i) => d === b[i])
    }

    /** One serialised write: persist, then adopt the list (dropping the answers of removed domains) and signal when it changed. */
    private async Apply(domains: readonly string[]): Promise<void>
    {
        await this.Write(domains)
        if (ConsoleEmailDomainStore.SameList(this.domains, domains))
        {
            return
        }
        this.domains = domains
        this.verifications = new Map([...this.verifications].filter(([d]) => domains.includes(d)))
        this.Changed.emit(domains)
    }

    private Write(domains: readonly string[]): Promise<void>
    {
        return this.slot.Write([...domains])
    }
}
