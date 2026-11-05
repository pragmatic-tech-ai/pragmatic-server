import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import { EmailDomainPolicy } from './email-domain-policy.js'
import { EmailDomainsNotEditableError, type ITenantEmailDomains, type TenantEmailDomainsView } from './tenant-api/tenant-email-domains.js'

/**
 * The in-hive console's own email domains, kept in `<dataRoot>/email-domains.json` (`{ "domains": string[] }`). Until the
 * Owner first saves a list, the domains are the seed's (the tenant record copied in at install), filtered by
 * EmailDomainPolicy; opening never writes. Writes are serialised and atomic (unique temp file, then rename), and `Changed`
 * fires after each write that changed the list, carrying the new list (the advert sender re-sends on it).
 */
export class ConsoleEmailDomainStore implements ITenantEmailDomains
{
    public static readonly FileName = 'email-domains.json'
    private static readonly DomainsKey = 'domains'
    private static readonly Utf8 = 'utf8'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly TempSuffix = '.tmp'
    private static readonly JsonIndent = 2
    private static readonly MalformedPrefix = 'Invalid email domains file (expected { "domains": string[] }): '
    private static readonly NotEditableMessage = 'This console sets only its own tenant\'s email domains.'

    public readonly Changed = new Signal<readonly string[]>()
    private domains: readonly string[]
    private writes: Promise<void> = Promise.resolve()

    private constructor(
        private readonly filePath: string,
        private readonly tenantId: string,
        domains: readonly string[])
    {
        this.domains = domains
    }

    /** File absent -> the seed domains (EmailDomainPolicy.Filter; refused seed entries dropped); never writes on open. A malformed file throws naming it. */
    public static async Open(filePath: string, tenantId: string, seedDomains: readonly string[] | undefined): Promise<ConsoleEmailDomainStore>
    {
        let text: string
        try
        {
            text = await readFile(filePath, ConsoleEmailDomainStore.Utf8)
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code !== ConsoleEmailDomainStore.NotFoundCode)
            {
                throw err
            }
            return new ConsoleEmailDomainStore(filePath, tenantId, EmailDomainPolicy.Filter(seedDomains ?? []).accepted)
        }
        return new ConsoleEmailDomainStore(filePath, tenantId, EmailDomainPolicy.Filter(ConsoleEmailDomainStore.DomainsIn(text, filePath)).accepted)
    }

    public get Domains(): readonly string[]
    {
        return this.domains
    }

    /** Own tenant -> its domains, editable; any other id -> nothing, not editable. */
    public For(tenantId: string): TenantEmailDomainsView
    {
        return tenantId === this.tenantId ? { domains: [...this.domains], editable: true, inHive: true } : { domains: [], editable: false, inHive: true }
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
        return { domains: [...parsed], editable: true, inHive: true }
    }

    private static DomainsIn(text: string, filePath: string): string[]
    {
        let body: unknown
        try
        {
            body = JSON.parse(text)
        }
        catch
        {
            throw new Error(ConsoleEmailDomainStore.MalformedPrefix + filePath)
        }
        const domains = body !== null && typeof body === 'object' && !Array.isArray(body)
            ? (body as Record<string, unknown>)[ConsoleEmailDomainStore.DomainsKey]
            : undefined
        if (!Array.isArray(domains) || !domains.every(d => typeof d === 'string'))
        {
            throw new Error(ConsoleEmailDomainStore.MalformedPrefix + filePath)
        }
        return domains as string[]
    }

    private static SameList(a: readonly string[], b: readonly string[]): boolean
    {
        return a.length === b.length && a.every((d, i) => d === b[i])
    }

    /** One serialised write: persist, then adopt the list and signal when it changed. */
    private async Apply(domains: readonly string[]): Promise<void>
    {
        await this.Write(domains)
        if (ConsoleEmailDomainStore.SameList(this.domains, domains))
        {
            return
        }
        this.domains = domains
        this.Changed.emit(domains)
    }

    private async Write(domains: readonly string[]): Promise<void>
    {
        await mkdir(dirname(this.filePath), { recursive: true })
        const temp = `${this.filePath}.${randomUUID()}${ConsoleEmailDomainStore.TempSuffix}`
        await writeFile(temp, JSON.stringify({ [ConsoleEmailDomainStore.DomainsKey]: domains }, null, ConsoleEmailDomainStore.JsonIndent), ConsoleEmailDomainStore.Utf8)
        try
        {
            await rename(temp, this.filePath)
        }
        catch (err)
        {
            await unlink(temp).catch(() => undefined)
            throw err
        }
    }
}
