import { DnsNames } from './dns-names.js'

/** An email domain list that cannot be used; the message is one plain sentence safe to show the operator (maps to 400). */
export class InvalidEmailDomainError extends Error
{
    private static readonly ErrorName = 'InvalidEmailDomainError'

    public constructor(message: string)
    {
        super(message)
        this.name = InvalidEmailDomainError.ErrorName
    }
}

/** Which email domains may identify a tenant: ordinary company domains only, never a public mail provider. */
export class EmailDomainPolicy
{
    public static readonly MaxDomains = 20
    private static readonly Dot = '.'
    private static readonly At = '@'
    private static readonly CharsetPattern = /^[a-z0-9.-]+$/
    private static readonly AllDigitsPattern = /^[0-9]+$/
    private static readonly MaxBrandSuffixLabels = 2
    private static readonly MaxBrandSuffixLabelLength = 3
    private static readonly NonAsciiPattern = /[^\x00-\x7f]/
    private static readonly NotAsciiSuffix = ' is not an ASCII domain name: enter its internationalised form, which starts with xn--.'
    private static readonly PublicSuffixSuffix = ' is a public domain suffix shared by many organisations, so it cannot point to one tenant.'
    private static readonly NotValidSuffix =' is not a valid domain name.'
    private static readonly PublicMailSuffix = ' is a public mail domain: anyone can have an address there, so it cannot point to one tenant.'
    private static readonly TooMany = 'List at most 20 email domains.'
    private static readonly NotAList = 'Email domains must be a list of domain names.'
    private static readonly PublicMailDomains: ReadonlySet<string> = new Set([
        'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'rocketmail.com',
        'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de',
        'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com', '126.com', 'fastmail.com', 'hey.com',
        'tutanota.com', 'tuta.io',
    ])
    private static readonly PublicMailBrands: ReadonlySet<string> = new Set([
        'gmail', 'googlemail', 'hotmail', 'outlook', 'yahoo', 'ymail', 'aol', 'gmx', 'yandex', 'protonmail',
    ])

    /** trim, lowercase, drop one trailing '.' */
    public static Normalise(raw: string): string
    {
        const lower = raw.trim().toLowerCase()
        return lower.endsWith(EmailDomainPolicy.Dot) ? lower.slice(0, -1) : lower
    }

    /** undefined when acceptable, else the refusal sentence naming the (normalised) domain. */
    public static Check(domain: string): string | undefined
    {
        const syntax = EmailDomainPolicy.CheckSyntax(domain)
        if (syntax !== undefined)
        {
            return syntax
        }
        if (DnsNames.IsPublicSuffix(domain))
        {
            return domain + EmailDomainPolicy.PublicSuffixSuffix
        }
        if (EmailDomainPolicy.IsPublicMail(domain))
        {
            return domain + EmailDomainPolicy.PublicMailSuffix
        }
        return undefined
    }

    /**
     * The shape rules only (ASCII, DNS syntax, at most 253 characters), without the public-suffix and public-mail refusals: undefined
     * when the (normalised) value is a well-formed domain name, else the refusal sentence. For clearing an approval the policy has
     * since come to refuse, while still keeping arbitrary text out.
     */
    public static CheckSyntax(domain: string): string | undefined
    {
        if (EmailDomainPolicy.NonAsciiPattern.test(domain))
        {
            return domain + EmailDomainPolicy.NotAsciiSuffix
        }
        if (!EmailDomainPolicy.IsValidName(domain))
        {
            return domain + EmailDomainPolicy.NotValidSuffix
        }
        return undefined
    }

    /** Array of strings -> normalised, deduped, sorted; throws InvalidEmailDomainError (not a list / > MaxDomains / first refused domain). */
    public static Parse(value: unknown): string[]
    {
        if (!Array.isArray(value) || !value.every(v => typeof v === 'string'))
        {
            throw new InvalidEmailDomainError(EmailDomainPolicy.NotAList)
        }
        const domains = EmailDomainPolicy.Distinct(value as string[])
        if (domains.length > EmailDomainPolicy.MaxDomains)
        {
            throw new InvalidEmailDomainError(EmailDomainPolicy.TooMany)
        }
        for (const domain of domains)
        {
            const refusal = EmailDomainPolicy.Check(domain)
            if (refusal !== undefined)
            {
                throw new InvalidEmailDomainError(refusal)
            }
        }
        return domains
    }

    /** Splits already-string values into accepted (normalised, deduped, sorted) and refused (normalised, in input order). */
    public static Filter(values: readonly string[]): { accepted: string[]; refused: string[] }
    {
        const accepted = new Set<string>()
        const refused: string[] = []
        for (const value of values)
        {
            const domain = EmailDomainPolicy.Normalise(value)
            if (EmailDomainPolicy.Check(domain) === undefined)
            {
                accepted.add(domain)
            }
            else
            {
                refused.push(domain)
            }
        }
        return { accepted: [...accepted].sort(), refused }
    }

    /** Normalised part after the last '@'; undefined when there is no '@' or nothing after it. */
    public static DomainOf(email: string): string | undefined
    {
        const at = email.lastIndexOf(EmailDomainPolicy.At)
        if (at < 0)
        {
            return undefined
        }
        const domain = EmailDomainPolicy.Normalise(email.slice(at + 1))
        return domain.length === 0 ? undefined : domain
    }

    /** The values normalised (Normalise), deduped and sorted. */
    public static Distinct(values: readonly string[]): string[]
    {
        return [...new Set(values.map(v => EmailDomainPolicy.Normalise(v)))].sort()
    }

    private static IsValidName(domain: string): boolean
    {
        if (!EmailDomainPolicy.CharsetPattern.test(domain) || !DnsNames.HasValidSyntax(domain))
        {
            return false
        }
        const labels = domain.split(EmailDomainPolicy.Dot)
        return !EmailDomainPolicy.AllDigitsPattern.test(labels[labels.length - 1])
    }

    private static IsPublicMail(domain: string): boolean
    {
        if (EmailDomainPolicy.PublicMailDomains.has(domain))
        {
            return true
        }
        const [brand, ...rest] = domain.split(EmailDomainPolicy.Dot)
        return EmailDomainPolicy.PublicMailBrands.has(brand)
            && rest.length >= 1 && rest.length <= EmailDomainPolicy.MaxBrandSuffixLabels
            && rest.every(l => l.length <= EmailDomainPolicy.MaxBrandSuffixLabelLength)
    }
}
