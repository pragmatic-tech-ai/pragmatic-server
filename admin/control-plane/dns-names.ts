/** DNS name rules shared by the development CA, the hive console settings and the email-domain policy. */
export class DnsNames
{
    public static readonly MaxNameLength = 253
    private static readonly Dot = '.'
    private static readonly MinLabels = 2
    private static readonly LabelPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
    // Well-known multi-label public suffixes (not exhaustive): a CA constrained to one would span unrelated owners.
    private static readonly PublicSuffixes: ReadonlySet<string> = new Set([
        'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk',
        'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'net.nz', 'govt.nz',
        'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'co.in', 'net.in', 'org.in',
        'com.br', 'net.br', 'org.br', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.mx', 'org.mx',
        'co.za', 'org.za', 'com.sg', 'com.hk', 'com.tw', 'com.tr', 'com.ar', 'com.ua', 'co.il', 'co.id',
    ])

    /** One lowercase DNS label: 1-63 letters, digits and inner hyphens. */
    public static IsLabel(label: string): boolean
    {
        return DnsNames.LabelPattern.test(label)
    }

    /**
     * True for a domain a development CA (or a console host) may use: lowercase DNS labels, at least two of them,
     * at most 253 characters, and not a well-known public suffix.
     */
    public static IsValidDomain(domain: string): boolean
    {
        const labels = domain.split(DnsNames.Dot)
        return domain.length <= DnsNames.MaxNameLength
            && labels.length >= DnsNames.MinLabels
            && labels.every(l => DnsNames.IsLabel(l))
            && !DnsNames.PublicSuffixes.has(domain)
    }
}
