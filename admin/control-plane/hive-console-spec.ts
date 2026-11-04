import { DevCertificateAuthority } from './dev-certificate-authority.js'
import { IngressTlsPolicy, IngressTlsSource, type IngressTls } from './ingress-tls.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'

/** Where a hive's tenant console is served and how it is secured. */
export type HiveConsoleSpec = { baseDomain: string; host?: string; tls: IngressTls }

/** A console setting that cannot be used; the message is a plain sentence safe to show the operator (maps to 400). */
export class InvalidHiveConsoleError extends Error
{
    private static readonly ErrorName = 'InvalidHiveConsoleError'

    public constructor(message: string)
    {
        super(message)
        this.name = InvalidHiveConsoleError.ErrorName
    }
}

/** Validation and host rules of the per-hive console settings. */
export class HiveConsoleSpecs
{
    private static readonly BaseDomainKey = 'baseDomain'
    private static readonly HostKey = 'host'
    private static readonly TlsKey = 'tls'
    private static readonly Dot = '.'
    private static readonly TopKeys: ReadonlySet<string> = new Set([HiveConsoleSpecs.BaseDomainKey, HiveConsoleSpecs.HostKey, HiveConsoleSpecs.TlsKey])
    private static readonly TlsKeys: ReadonlySet<string> = new Set(['source', 'secretName', 'clusterIssuer'])
    private static readonly UnknownField = ' is not a console setting.'
    private static readonly UnknownTlsField = ' is not a TLS setting.'
    private static readonly BadEffectiveHost = 'The console host this tenant would get is not a valid host name; give the console an explicit host.'
    private static readonly MustBeObject = 'The console settings must be an object.'
    private static readonly BadBaseDomain = 'The base domain must be a lowercase host name of at least two labels, such as example.com (not a public suffix such as co.uk).'
    private static readonly BadHost = 'The console host must be a lowercase host name of at least two labels, such as console.example.com.'
    private static readonly HostOutsideDomain = 'With development TLS the console host must be the base domain or a name under it.'

    public static Parse(body: unknown): HiveConsoleSpec
    {
        if (typeof body !== 'object' || body === null || Array.isArray(body))
        {
            throw new InvalidHiveConsoleError(HiveConsoleSpecs.MustBeObject)
        }
        const raw = body as Record<string, unknown>
        for (const key of Object.keys(raw))
        {
            if (!HiveConsoleSpecs.TopKeys.has(key))
            {
                throw new InvalidHiveConsoleError(`"${key}"${HiveConsoleSpecs.UnknownField}`)
            }
        }
        const rawTls = raw[HiveConsoleSpecs.TlsKey]
        if (typeof rawTls === 'object' && rawTls !== null && !Array.isArray(rawTls))
        {
            for (const key of Object.keys(rawTls))
            {
                if (!HiveConsoleSpecs.TlsKeys.has(key))
                {
                    throw new InvalidHiveConsoleError(`"${key}"${HiveConsoleSpecs.UnknownTlsField}`)
                }
            }
        }
        const baseDomain = raw[HiveConsoleSpecs.BaseDomainKey]
        if (typeof baseDomain !== 'string' || !DevCertificateAuthority.IsValidDomain(baseDomain))
        {
            throw new InvalidHiveConsoleError(HiveConsoleSpecs.BadBaseDomain)
        }
        const host = raw[HiveConsoleSpecs.HostKey]
        const hasHost = host !== undefined
        if (hasHost && (typeof host !== 'string' || !DevCertificateAuthority.IsValidDomain(host)))
        {
            throw new InvalidHiveConsoleError(HiveConsoleSpecs.BadHost)
        }
        const tls = IngressTlsPolicy.Parse(raw[HiveConsoleSpecs.TlsKey])
        const spec: HiveConsoleSpec = hasHost ? { baseDomain, host: host as string, tls } : { baseDomain, tls }
        HiveConsoleSpecs.ValidateHostRules(spec, spec.host ?? baseDomain)
        return spec
    }

    /** Checks the host this spec gives the tenant (DNS rules; under the base domain for development TLS); throws InvalidHiveConsoleError. */
    public static Validate(spec: HiveConsoleSpec, tenantId: string): void
    {
        const host = HiveConsoleSpecs.HostOf(spec, tenantId)
        if (!DevCertificateAuthority.IsValidDomain(host))
        {
            throw new InvalidHiveConsoleError(HiveConsoleSpecs.BadEffectiveHost)
        }
        HiveConsoleSpecs.ValidateHostRules(spec, host)
    }

    private static ValidateHostRules(spec: HiveConsoleSpec, host: string): void
    {
        if (spec.tls.source === IngressTlsSource.Development && !HiveConsoleSpecs.IsWithin(host, spec.baseDomain))
        {
            throw new InvalidHiveConsoleError(HiveConsoleSpecs.HostOutsideDomain)
        }
    }

    /** The browser host of the tenant's console: the explicit host, else console-<tenant>.<baseDomain>. */
    public static HostOf(spec: HiveConsoleSpec, tenantId: string): string
    {
        return spec.host ?? K8sManifestBuilder.ConsoleHostOf(tenantId, spec.baseDomain)
    }

    private static IsWithin(host: string, baseDomain: string): boolean
    {
        return host === baseDomain || host.endsWith(HiveConsoleSpecs.Dot + baseDomain)
    }
}
