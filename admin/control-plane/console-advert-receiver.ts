import { ConsoleAdvertLimits } from './console-advert-contract.js'
import type { ConsoleAdvertRecord, ConsoleAdvertRegistry } from './console-advert-registry.js'
import { EmailDomainPolicy } from './email-domain-policy.js'
import { HiveConsoleSpecs } from './hive-console-spec.js'
import type { HiveRecord } from './platform-records.js'
import type { DomainVerificationAnswer } from './domain-verification-record.js'
import { DomainVerificationUnavailableError } from './tenant-api/tenant-email-domains.js'

/** A console advert that is malformed or claims an address that is not this hive's console (maps to 400). */
export class InvalidConsoleAdvertError extends Error
{
    private static readonly ErrorName = 'InvalidConsoleAdvertError'

    public constructor(message: string)
    {
        super(message)
        this.name = InvalidConsoleAdvertError.ErrorName
    }
}

/** The hive does not run an in-hive console (maps to 409). */
export class ConsoleNotEnabledError extends Error
{
    private static readonly ErrorName = 'ConsoleNotEnabledError'
    private static readonly Text = 'The tenant console is not enabled for this hive.'

    public constructor()
    {
        super(ConsoleNotEnabledError.Text)
        this.name = ConsoleNotEnabledError.ErrorName
    }
}

/** A stored advert, the email domains refused from it, and the tenant's last operator Owner reset when there is one. */
export type ConsoleAdvertOutcome = { record: ConsoleAdvertRecord; refusedEmailDomains: string[]; ownerResetAt?: string; domainVerifications?: DomainVerificationAnswer[] }

/** Where the receiver learns the DNS TXT verification state of a tenant's claimed domains (PlatformEmailDomains satisfies it). */
export interface IConsoleDomainVerifications
{
    AnswersFor(tenantId: string, domains: readonly string[]): Promise<DomainVerificationAnswer[]>
    VerifyDomain(tenantId: string, domain: string): Promise<DomainVerificationAnswer>
}

export interface IConsoleAdvertDirectory
{
    GetHive(id: string): HiveRecord | undefined
}

/** The time of a tenant's last operator Owner reset of its in-hive console (ConsoleOwnerResets); undefined when none. */
export interface IOwnerResetSource
{
    Of(tenantId: string): string | undefined
}

/**
 * Validates what an in-hive console reports about itself and stores it as the tenant's advert; the outcome also carries the
 * tenant's last operator Owner reset (read from `ownerResets`) so the console can end the Owner's sessions.
 */
export class ConsoleAdvertReceiver
{
    public static readonly BadShape = 'The console advert must be a JSON object with consoleUrl, fingerprints and emailDomains.'
    private static readonly BadUrl = 'consoleUrl must be the https address of this hive console, with no path, query or port.'
    private static readonly BadFingerprints = 'fingerprints must be a list of at most 10000 SHA-256 hex digests.'
    private static readonly BadDomains = 'emailDomains must be a list of at most 20 domain names.'
    public static readonly BadVerifyShape = 'The verify request must be a JSON object with domain.'
    private static readonly VerificationUnavailable = 'Domain verification is not available.'
    private static readonly HttpsProtocol = 'https:'
    private static readonly RootPath = '/'
    private static readonly HttpsPrefix = 'https://'
    private static readonly Empty = ''

    public constructor(
        private readonly directory: IConsoleAdvertDirectory,
        private readonly store: ConsoleAdvertRegistry,
        private readonly now: () => Date = () => new Date(),
        private readonly ownerResets?: IOwnerResetSource,
        private readonly domains?: IConsoleDomainVerifications)
    {
    }

    public async Receive(hiveId: string, body: unknown): Promise<ConsoleAdvertOutcome>
    {
        const hive = this.directory.GetHive(hiveId)
        if (hive === undefined || hive.console === undefined)
        {
            throw new ConsoleNotEnabledError()
        }
        const advert = ConsoleAdvertReceiver.ShapeOf(body)
        const consoleUrl = ConsoleAdvertReceiver.CheckedUrl(advert.consoleUrl, HiveConsoleSpecs.HostOf(hive.console, hive.tenantId).toLowerCase())
        const fingerprints = ConsoleAdvertReceiver.CheckedFingerprints(advert.fingerprints)
        if (advert.emailDomains.length > EmailDomainPolicy.MaxDomains)
        {
            throw new InvalidConsoleAdvertError(ConsoleAdvertReceiver.BadDomains)
        }
        const domains = EmailDomainPolicy.Filter(advert.emailDomains)
        const record = await this.store.Report({
            tenantId: hive.tenantId,
            hiveId,
            consoleUrl,
            fingerprints,
            emailDomains: domains.accepted,
            reportedAt: this.now().toISOString(),
        }, () => this.StillRunsConsole(hiveId, hive.tenantId))
        if (record === undefined)
        {
            throw new ConsoleNotEnabledError()
        }
        const outcome: ConsoleAdvertOutcome = { record, refusedEmailDomains: domains.refused }
        const ownerResetAt = this.ownerResets?.Of(hive.tenantId)
        if (ownerResetAt !== undefined)
        {
            outcome.ownerResetAt = ownerResetAt
        }
        if (this.domains !== undefined)
        {
            outcome.domainVerifications = await this.domains.AnswersFor(hive.tenantId, domains.accepted)
        }
        return outcome
    }

    /** Verifies one of the tenant's claimed domains now; only the hive's tenant and the body's domain reach the verifier. */
    public async VerifyDomain(hiveId: string, body: unknown): Promise<DomainVerificationAnswer>
    {
        const hive = this.directory.GetHive(hiveId)
        if (hive === undefined || hive.console === undefined)
        {
            throw new ConsoleNotEnabledError()
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body) || typeof (body as Record<string, unknown>).domain !== 'string')
        {
            throw new InvalidConsoleAdvertError(ConsoleAdvertReceiver.BadVerifyShape)
        }
        if (this.domains === undefined)
        {
            throw new DomainVerificationUnavailableError(ConsoleAdvertReceiver.VerificationUnavailable)
        }
        return await this.domains.VerifyDomain(hive.tenantId, (body as { domain: string }).domain)
    }

    /**
     * Re-read at write time: the hive still exists for the same tenant and still has its console setting. A console removal or hive
     * delete clears the setting first and forgets the advert after, so an advert checked here after the clear is refused (409).
     */
    private StillRunsConsole(hiveId: string, tenantId: string): boolean
    {
        const hive = this.directory.GetHive(hiveId)
        return hive !== undefined && hive.tenantId === tenantId && hive.console !== undefined
    }

    private static ShapeOf(body: unknown): { consoleUrl: string; fingerprints: string[]; emailDomains: string[] }
    {
        if (typeof body !== 'object' || body === null || Array.isArray(body))
        {
            throw new InvalidConsoleAdvertError(ConsoleAdvertReceiver.BadShape)
        }
        const { consoleUrl, fingerprints, emailDomains } = body as Record<string, unknown>
        if (typeof consoleUrl !== 'string' || !ConsoleAdvertReceiver.IsStringList(fingerprints) || !ConsoleAdvertReceiver.IsStringList(emailDomains))
        {
            throw new InvalidConsoleAdvertError(ConsoleAdvertReceiver.BadShape)
        }
        return { consoleUrl, fingerprints, emailDomains }
    }

    private static IsStringList(value: unknown): value is string[]
    {
        return Array.isArray(value) && value.every(v => typeof v === 'string')
    }

    private static CheckedUrl(raw: string, expectedHost: string): string
    {
        let url: URL | undefined
        if (raw.length <= ConsoleAdvertLimits.MaxUrlLength)
        {
            url = URL.canParse(raw) ? new URL(raw) : undefined
        }
        if (url === undefined)
        {
            throw new InvalidConsoleAdvertError(ConsoleAdvertReceiver.BadUrl)
        }
        const plain = url.protocol === ConsoleAdvertReceiver.HttpsProtocol
            && url.username === ConsoleAdvertReceiver.Empty && url.password === ConsoleAdvertReceiver.Empty
            && url.port === ConsoleAdvertReceiver.Empty && url.search === ConsoleAdvertReceiver.Empty && url.hash === ConsoleAdvertReceiver.Empty
            && url.pathname === ConsoleAdvertReceiver.RootPath
            && url.hostname === expectedHost
        if (!plain)
        {
            throw new InvalidConsoleAdvertError(ConsoleAdvertReceiver.BadUrl)
        }
        return ConsoleAdvertReceiver.HttpsPrefix + url.hostname
    }

    private static CheckedFingerprints(values: readonly string[]): string[]
    {
        if (values.length > ConsoleAdvertLimits.MaxFingerprints || !values.every(v => ConsoleAdvertLimits.FingerprintPattern.test(v)))
        {
            throw new InvalidConsoleAdvertError(ConsoleAdvertReceiver.BadFingerprints)
        }
        return [...new Set(values)].sort()
    }
}
