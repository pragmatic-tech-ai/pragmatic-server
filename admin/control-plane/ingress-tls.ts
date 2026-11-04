import { TenantAdminEnv } from './tenant-admin-env.js'

/** Where the TLS certificate of a served Ingress comes from. */
export enum IngressTlsSource
{
    ExistingSecret = 'existing-secret',
    CertManager = 'cert-manager',
    Development = 'development',
}

/** The operator's TLS choice for the Ingresses the hive renders (environments and IdPs). */
export type IngressTls = { source: IngressTlsSource; secretName?: string; clusterIssuer?: string }

/** A TLS choice that cannot be used; the message is a plain sentence safe to show the operator (maps to 400). */
export class InvalidIngressTlsError extends Error
{
    private static readonly ErrorName = 'InvalidIngressTlsError'

    public constructor(message: string)
    {
        super(message)
        this.name = InvalidIngressTlsError.ErrorName
    }
}

/** Validation and rendering rules of the Ingress TLS choice. */
export class IngressTlsPolicy
{
    public static readonly DevelopmentSecretName = 'pragmatic-dev-tls'
    public static readonly CertManagerAnnotation = 'cert-manager.io/cluster-issuer'
    public static readonly TlsSecretType = 'kubernetes.io/tls'
    /**
     * Suffix of the Secret cert-manager writes. Deliberately not `-tls`: the IdP's own server-key Secret is
     * `<idpName>-tls` (InClusterIdpSeedSource.TlsSecretNameOf) and cert-manager must never overwrite it.
     */
    private static readonly CertManagerSecretSuffix = '-ingress-tls'
    private static readonly MaxNameLength = 253
    private static readonly NamePattern = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/
    private static readonly SecretNameKey = 'secretName'
    private static readonly ClusterIssuerKey = 'clusterIssuer'
    private static readonly SourceKey = 'source'
    private static readonly MustBeObject = 'The TLS settings must be an object.'
    private static readonly UnknownSource = 'Choose the TLS source: existing-secret, cert-manager or development.'
    private static readonly SecretRequired = 'Name the TLS Secret to use (an existing kubernetes.io/tls Secret in pragmatic-system).'
    private static readonly IssuerRequired = 'Name the cert-manager ClusterIssuer to use.'
    private static readonly SecretForbidden = 'A TLS Secret name only applies to the existing-secret source.'
    private static readonly IssuerForbidden = 'A ClusterIssuer only applies to the cert-manager source.'
    private static readonly BadSecretName = 'The TLS Secret name must be a lowercase DNS name (letters, digits, dashes and dots, at most 253 characters).'
    private static readonly BadIssuerName = 'The ClusterIssuer name must be a lowercase DNS name (letters, digits, dashes and dots, at most 253 characters).'

    public static Parse(value: unknown): IngressTls
    {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
        {
            throw new InvalidIngressTlsError(IngressTlsPolicy.MustBeObject)
        }
        const raw = value as Record<string, unknown>
        const source = raw[IngressTlsPolicy.SourceKey]
        if (!Object.values(IngressTlsSource).includes(source as IngressTlsSource))
        {
            throw new InvalidIngressTlsError(IngressTlsPolicy.UnknownSource)
        }
        const secretName = raw[IngressTlsPolicy.SecretNameKey]
        const clusterIssuer = raw[IngressTlsPolicy.ClusterIssuerKey]
        const hasSecret = secretName !== undefined && secretName !== ''
        const hasIssuer = clusterIssuer !== undefined && clusterIssuer !== ''
        switch (source as IngressTlsSource)
        {
            case IngressTlsSource.ExistingSecret:
                if (!hasSecret)
                {
                    throw new InvalidIngressTlsError(IngressTlsPolicy.SecretRequired)
                }
                if (hasIssuer)
                {
                    throw new InvalidIngressTlsError(IngressTlsPolicy.IssuerForbidden)
                }
                IngressTlsPolicy.AssertName(secretName, IngressTlsPolicy.BadSecretName)
                return { source: IngressTlsSource.ExistingSecret, secretName: secretName as string }
            case IngressTlsSource.CertManager:
                if (!hasIssuer)
                {
                    throw new InvalidIngressTlsError(IngressTlsPolicy.IssuerRequired)
                }
                if (hasSecret)
                {
                    throw new InvalidIngressTlsError(IngressTlsPolicy.SecretForbidden)
                }
                IngressTlsPolicy.AssertName(clusterIssuer, IngressTlsPolicy.BadIssuerName)
                return { source: IngressTlsSource.CertManager, clusterIssuer: clusterIssuer as string }
            default:
                if (hasSecret)
                {
                    throw new InvalidIngressTlsError(IngressTlsPolicy.SecretForbidden)
                }
                if (hasIssuer)
                {
                    throw new InvalidIngressTlsError(IngressTlsPolicy.IssuerForbidden)
                }
                return { source: IngressTlsSource.Development }
        }
    }

    /** existing-secret: its secretName; development: pragmatic-dev-tls; cert-manager: `<ingressName>-ingress-tls` (cert-manager writes it). */
    public static SecretNameFor(tls: IngressTls, ingressName: string): string
    {
        switch (tls.source)
        {
            case IngressTlsSource.ExistingSecret:
                return tls.secretName as string
            case IngressTlsSource.CertManager:
                return ingressName + IngressTlsPolicy.CertManagerSecretSuffix
            default:
                return IngressTlsPolicy.DevelopmentSecretName
        }
    }

    /** cert-manager: { 'cert-manager.io/cluster-issuer': clusterIssuer }; otherwise {}. */
    public static AnnotationsFor(tls: IngressTls): Record<string, string>
    {
        return tls.source === IngressTlsSource.CertManager
            ? { [IngressTlsPolicy.CertManagerAnnotation]: tls.clusterIssuer as string }
            : {}
    }

    /** True for existing-secret and development: the Secret must be copied into each Ingress's namespace. */
    public static CopiesSecret(tls: IngressTls): boolean
    {
        return tls.source !== IngressTlsSource.CertManager
    }

    public static ToEnv(tls: IngressTls): Record<string, string>
    {
        const env: Record<string, string> = { [TenantAdminEnv.IngressTlsSource]: tls.source }
        if (tls.secretName !== undefined)
        {
            env[TenantAdminEnv.IngressTlsSecret] = tls.secretName
        }
        if (tls.clusterIssuer !== undefined)
        {
            env[TenantAdminEnv.IngressTlsIssuer] = tls.clusterIssuer
        }
        return env
    }

    public static FromEnv(env: NodeJS.ProcessEnv): IngressTls | undefined
    {
        const source = env[TenantAdminEnv.IngressTlsSource]
        if (source === undefined || source === '')
        {
            return undefined
        }
        return IngressTlsPolicy.Parse({
            source,
            secretName: env[TenantAdminEnv.IngressTlsSecret],
            clusterIssuer: env[TenantAdminEnv.IngressTlsIssuer],
        })
    }

    private static AssertName(value: unknown, message: string): void
    {
        if (typeof value !== 'string' || value.length > IngressTlsPolicy.MaxNameLength || !IngressTlsPolicy.NamePattern.test(value))
        {
            throw new InvalidIngressTlsError(message)
        }
    }
}
