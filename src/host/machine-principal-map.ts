import { createHash } from 'node:crypto'

/** A normalized view of a presented TLS client certificate. The fingerprint is canonical lowercase-hex SHA-256 (no colons). */
export class MachineCertIdentity
{
    private static readonly ColonSeparator = ':'
    private static readonly HashAlgorithm = 'sha256'
    private static readonly HexEncoding = 'hex'
    private static readonly EmptyText = ''

    public readonly Authorized: boolean
    public readonly Fingerprint: string
    public readonly Subject: string

    public constructor(authorized: boolean, fingerprint: string, subject: string)
    {
        this.Authorized = authorized
        this.Fingerprint = fingerprint
        this.Subject = subject
    }

    public static FromPeerCertificate(authorized: boolean, cert: { raw?: Buffer; fingerprint256?: string; subject?: { CN?: string } }): MachineCertIdentity
    {
        const fingerprint = MachineCertIdentity.ComputeFingerprint(cert)
        const subject = cert.subject?.CN ?? MachineCertIdentity.EmptyText
        return new MachineCertIdentity(authorized && fingerprint.length > 0, fingerprint, subject)
    }

    private static ComputeFingerprint(cert: { raw?: Buffer; fingerprint256?: string }): string
    {
        if (cert.fingerprint256 !== undefined && cert.fingerprint256.length > 0)
        {
            return cert.fingerprint256.split(MachineCertIdentity.ColonSeparator).join(MachineCertIdentity.EmptyText).toLowerCase()
        }
        if (cert.raw !== undefined && cert.raw.length > 0)
        {
            return createHash(MachineCertIdentity.HashAlgorithm).update(cert.raw).digest(MachineCertIdentity.HexEncoding)
        }
        return MachineCertIdentity.EmptyText
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

    public Lookup(fingerprint: string): MachinePrincipalEntry | undefined
    {
        return this.entries.get(fingerprint)
    }
}
