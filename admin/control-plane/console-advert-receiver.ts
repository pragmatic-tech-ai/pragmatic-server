import { ConsoleAdvertLimits } from './console-advert-contract.js'
import type { ConsoleAdvertRecord, ConsoleAdvertRegistry } from './console-advert-registry.js'
import { EmailDomainPolicy } from './email-domain-policy.js'
import { HiveConsoleSpecs } from './hive-console-spec.js'
import type { HiveRecord } from './platform-records.js'

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

export type ConsoleAdvertOutcome = { record: ConsoleAdvertRecord; refusedEmailDomains: string[] }

export interface IConsoleAdvertDirectory
{
    GetHive(id: string): HiveRecord | undefined
}

/** Validates what an in-hive console reports about itself and stores it as the tenant's advert. */
export class ConsoleAdvertReceiver
{
    public static readonly BadShape = 'The console advert must be a JSON object with consoleUrl, fingerprints and emailDomains.'
    private static readonly BadUrl = 'consoleUrl must be the https address of this hive console, with no path, query or port.'
    private static readonly BadFingerprints = 'fingerprints must be a list of at most 10000 SHA-256 hex digests.'
    private static readonly BadDomains = 'emailDomains must be a list of at most 20 domain names.'
    private static readonly HttpsProtocol = 'https:'
    private static readonly RootPath = '/'
    private static readonly HttpsPrefix = 'https://'
    private static readonly Empty = ''

    public constructor(
        private readonly directory: IConsoleAdvertDirectory,
        private readonly store: ConsoleAdvertRegistry,
        private readonly now: () => Date = () => new Date())
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
        })
        return { record, refusedEmailDomains: domains.refused }
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
