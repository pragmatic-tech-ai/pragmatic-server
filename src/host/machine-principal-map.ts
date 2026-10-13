import { createHash } from 'node:crypto'

/** A normalized view of a presented TLS client certificate. The fingerprint is canonical lowercase-hex SHA-256 (no colons). */
export class MachineCertIdentity
{
    private static readonly ColonSeparator = ':'
    private static readonly HashAlgorithm = 'sha256'
    private static readonly HexEncoding = 'hex'
    private static readonly EmptyText = ''
    private static readonly CommaSeparator = ','

    public readonly Authorized: boolean
    public readonly Fingerprint: string
    public readonly Subject: string

    public constructor(authorized: boolean, fingerprint: string, subject: string)
    {
        this.Authorized = authorized
        this.Fingerprint = fingerprint
        this.Subject = subject
    }

    public static FromPeerCertificate(authorized: boolean, cert: { raw?: Buffer; fingerprint256?: string; subject?: { CN?: string | string[] } }): MachineCertIdentity
    {
        const fingerprint = MachineCertIdentity.ComputeFingerprint(cert)
        const cn = cert.subject?.CN
        const subject = Array.isArray(cn) ? cn.join(MachineCertIdentity.CommaSeparator) : cn ?? MachineCertIdentity.EmptyText
        return new MachineCertIdentity(authorized && fingerprint.length > 0, fingerprint, subject)
    }

    private static ComputeFingerprint(cert: { raw?: Buffer; fingerprint256?: string }): string
    {
        if (cert.raw !== undefined && cert.raw.length > 0)
        {
            return createHash(MachineCertIdentity.HashAlgorithm).update(cert.raw).digest(MachineCertIdentity.HexEncoding)
        }
        if (cert.fingerprint256 !== undefined && cert.fingerprint256.length > 0)
        {
            return MachineCertIdentity.Normalize(cert.fingerprint256)
        }
        return MachineCertIdentity.EmptyText
    }

    /** Canonical form: lowercase hex, no colons. */
    public static Normalize(fingerprint: string): string
    {
        return fingerprint.split(MachineCertIdentity.ColonSeparator).join(MachineCertIdentity.EmptyText).toLowerCase()
    }
}

export interface MachinePrincipalEntry
{
    PrincipalId: string
    Groups: readonly string[]
}

/** Maps a lowercase-hex SHA-256 cert fingerprint to the machine principal it identifies. */
export class MachinePrincipalMap
{
    public static readonly Empty = new MachinePrincipalMap(new Map())

    private readonly entries: ReadonlyMap<string, MachinePrincipalEntry>

    public constructor(entries: ReadonlyMap<string, MachinePrincipalEntry>)
    {
        this.entries = entries
    }

    public get IsEmpty(): boolean
    {
        return this.entries.size === 0
    }

    /** The canonical key is lowercase-hex-no-colons; the lookup key is normalized to that form. */
    public Lookup(fingerprint: string): MachinePrincipalEntry | undefined
    {
        return this.entries.get(MachineCertIdentity.Normalize(fingerprint))
    }
}
