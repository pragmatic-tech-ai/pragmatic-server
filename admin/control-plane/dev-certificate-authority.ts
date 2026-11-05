import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DevCaError } from '../../src/idp/dev-ca.js'
import { SealedSecretStore } from './sealed-secret-store.js'

export type IssuedCertificate = { cert: Buffer; key: Buffer }

export interface IDevCertificateIssuer
{
    /** The CA certificate PEM for the base domain, minting it once. */
    EnsureCa(baseDomain: string): Promise<Buffer>
    Issue(baseDomain: string, hosts: readonly string[]): Promise<IssuedCertificate>
    CaFileOf(baseDomain: string): string
}

/** The CA certificate exists but its sealed key is gone; a new CA is never minted silently. */
export class DevCaKeyMissingError extends Error
{
    private static readonly Text = 'The development certificate authority key is missing from the sealed store, so no new certificate can be signed. Remove the stored CA certificate for this domain deliberately to start a new CA.'
    private static readonly ErrorName = 'DevCaKeyMissingError'

    public constructor()
    {
        super(DevCaKeyMissingError.Text)
        this.name = DevCaKeyMissingError.ErrorName
    }
}

/** A host that is not the base domain or a name under it. */
export class DevCaHostOutsideDomainError extends Error
{
    private static readonly Text = 'A certificate host must be the base domain or a name under it (a wildcard may only be the whole first label): '
    private static readonly ErrorName = 'DevCaHostOutsideDomainError'

    public constructor(host: string)
    {
        super(DevCaHostOutsideDomainError.Text + host)
        this.name = DevCaHostOutsideDomainError.ErrorName
    }
}

/**
 * One development CA per base domain, name-constrained to that domain and minted with the openssl CLI.
 * The CA key lives only in the sealed store; it touches disk solely inside a short-lived staging
 * directory while a leaf is signed. On POSIX that directory and its key files are 0700/0600; on Windows
 * the modes are no-ops and the files are protected by the ACL inherited from rootDir (the user-owned
 * data directory), plus the staging directory's very short life. All operations on one instance are
 * serialized; a second instance on the same rootDir is safe because only stale staging dirs are swept.
 */
export class DevCertificateAuthority implements IDevCertificateIssuer
{
    public static readonly DirName = 'dev-ca'
    /** The openssl CLI as found on PATH (the default; tests pass another binary). */
    public static readonly OpensslCommand = 'openssl'
    private static readonly KeyRefPrefix = 'dev-ca-key/'
    private static readonly CaCertFile = 'ca.crt'
    private static readonly CaKeyFile = 'ca.key'
    private static readonly LeafKeyFile = 'leaf.key'
    private static readonly LeafCsrFile = 'leaf.csr'
    private static readonly LeafCertFile = 'leaf.crt'
    private static readonly LeafExtFile = 'leaf.ext'
    private static readonly StagingPrefix = '.dev-ca-staging-'
    private static readonly LabelPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
    private static readonly MaxNameLength = 253
    private static readonly MinBaseLabels = 2
    private static readonly StaleStagingMs = 10 * 60 * 1000
    // Well-known multi-label public suffixes (not exhaustive): a CA constrained to one would span unrelated owners.
    private static readonly PublicSuffixes: ReadonlySet<string> = new Set([
        'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk',
        'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'net.nz', 'govt.nz',
        'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'co.in', 'net.in', 'org.in',
        'com.br', 'net.br', 'org.br', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.mx', 'org.mx',
        'co.za', 'org.za', 'com.sg', 'com.hk', 'com.tw', 'com.tr', 'com.ar', 'com.ua', 'co.il', 'co.id',
    ])
    private static readonly CmdReq = 'req'
    private static readonly CmdX509 = 'x509'
    private static readonly FlagX509 = '-x509'
    private static readonly FlagReq = '-req'
    private static readonly FlagNewkey = '-newkey'
    private static readonly FlagNodes = '-nodes'
    private static readonly FlagKeyout = '-keyout'
    private static readonly FlagOut = '-out'
    private static readonly FlagIn = '-in'
    private static readonly FlagDays = '-days'
    private static readonly FlagSubj = '-subj'
    private static readonly FlagAddext = '-addext'
    private static readonly FlagCa = '-CA'
    private static readonly FlagCaKey = '-CAkey'
    private static readonly FlagCaCreateSerial = '-CAcreateserial'
    private static readonly FlagExtfile = '-extfile'
    private static readonly WildcardPrefix = '*.'
    private static readonly Dot = '.'
    private static readonly KeySpec = 'rsa:2048'
    private static readonly CaDays = '3650'
    private static readonly LeafDays = '397'
    private static readonly SubjectPrefix = '/CN='
    private static readonly CaSubjectPrefix = '/CN=Pragmatic Development CA ('
    private static readonly CaSubjectSuffix = ')'
    private static readonly CaBasicConstraints = 'basicConstraints=critical,CA:TRUE,pathlen:0'
    private static readonly CaKeyUsage = 'keyUsage=critical,keyCertSign,cRLSign'
    private static readonly NameConstraintsPrefix = 'nameConstraints=critical,permitted;DNS:'
    private static readonly SanPrefix = 'subjectAltName='
    private static readonly DnsPrefix = 'DNS:'
    private static readonly SanSeparator = ','
    private static readonly LeafExtensions = ['basicConstraints=CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth']
    private static readonly Eol = '\n'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly KeyMode = 0o600
    private static readonly DirMode = 0o700
    private static readonly BadBaseText = 'The base domain is invalid: '
    private static readonly OpensslFailed = 'Development CA: openssl failed (is the openssl CLI installed and on PATH?): '

    private chain: Promise<void> = Promise.resolve()

    public constructor(
        private readonly rootDir: string,
        private readonly store: SealedSecretStore,
        private readonly openssl: string = DevCertificateAuthority.OpensslCommand)
    {
    }

    public static KeyRefOf(baseDomain: string): string
    {
        return `${DevCertificateAuthority.KeyRefPrefix}${baseDomain}`
    }

    public CaFileOf(baseDomain: string): string
    {
        DevCertificateAuthority.CheckBase(baseDomain)
        return join(this.rootDir, baseDomain, DevCertificateAuthority.CaCertFile)
    }

    public EnsureCa(baseDomain: string): Promise<Buffer>
    {
        return this.Enqueue(() =>
        {
            DevCertificateAuthority.CheckBase(baseDomain)
            return this.EnsureCaNow(baseDomain)
        })
    }

    public Issue(baseDomain: string, hosts: readonly string[]): Promise<IssuedCertificate>
    {
        return this.Enqueue(async () =>
        {
            DevCertificateAuthority.CheckBase(baseDomain)
            DevCertificateAuthority.CheckHosts(baseDomain, hosts)
            await this.EnsureCaNow(baseDomain)
            return this.IssueNow(baseDomain, hosts)
        })
    }

    /**
     * True for a domain a development CA (or a console host) may use: lowercase DNS labels, at least two of them,
     * at most 253 characters, and not a well-known public suffix. The one validator shared with the hive console settings.
     */
    public static IsValidDomain(domain: string): boolean
    {
        const labels = domain.split(DevCertificateAuthority.Dot)
        return domain.length <= DevCertificateAuthority.MaxNameLength
            && labels.length >= DevCertificateAuthority.MinBaseLabels
            && labels.every(l => DevCertificateAuthority.LabelPattern.test(l))
            && !DevCertificateAuthority.PublicSuffixes.has(domain)
    }

    private static CheckBase(baseDomain: string): void
    {
        if (!DevCertificateAuthority.IsValidDomain(baseDomain))
        {
            throw new DevCaError(DevCertificateAuthority.BadBaseText + baseDomain)
        }
    }

    private static CheckHosts(baseDomain: string, hosts: readonly string[]): void
    {
        if (hosts.length === 0)
        {
            throw new DevCaHostOutsideDomainError('')
        }
        for (const host of hosts)
        {
            DevCertificateAuthority.CheckHost(baseDomain, host)
        }
    }

    private static CheckHost(baseDomain: string, host: string): void
    {
        const bare = host.startsWith(DevCertificateAuthority.WildcardPrefix) ? host.slice(DevCertificateAuthority.WildcardPrefix.length) : host
        const labelsOk = bare.length > 0 && host.length <= DevCertificateAuthority.MaxNameLength
            && bare.split(DevCertificateAuthority.Dot).every(l => DevCertificateAuthority.LabelPattern.test(l))
        const inDomain = bare === baseDomain || bare.endsWith(DevCertificateAuthority.Dot + baseDomain)
        if (!labelsOk || !inDomain)
        {
            throw new DevCaHostOutsideDomainError(host)
        }
    }

    private Enqueue<T>(work: () => Promise<T>): Promise<T>
    {
        const run = this.chain.then(work)
        this.chain = run.then(() => undefined, () => undefined)
        return run
    }

    private async EnsureCaNow(baseDomain: string): Promise<Buffer>
    {
        await this.SweepStaging()
        const certFile = this.CaFileOf(baseDomain)
        const keyRef = DevCertificateAuthority.KeyRefOf(baseDomain)
        const existing = await DevCertificateAuthority.ReadIfPresent(certFile)
        if (existing !== undefined)
        {
            if (await this.store.Get(keyRef) === undefined)
            {
                throw new DevCaKeyMissingError()
            }
            return existing
        }
        const stage = await this.NewStage()
        try
        {
            const keyFile = join(stage, DevCertificateAuthority.CaKeyFile)
            const stagedCert = join(stage, DevCertificateAuthority.CaCertFile)
            await this.Run([
                DevCertificateAuthority.CmdReq, DevCertificateAuthority.FlagX509, DevCertificateAuthority.FlagNewkey, DevCertificateAuthority.KeySpec, DevCertificateAuthority.FlagNodes,
                DevCertificateAuthority.FlagKeyout, keyFile, DevCertificateAuthority.FlagOut, stagedCert, DevCertificateAuthority.FlagDays, DevCertificateAuthority.CaDays,
                DevCertificateAuthority.FlagSubj, DevCertificateAuthority.CaSubjectPrefix + baseDomain + DevCertificateAuthority.CaSubjectSuffix,
                DevCertificateAuthority.FlagAddext, DevCertificateAuthority.CaBasicConstraints,
                DevCertificateAuthority.FlagAddext, DevCertificateAuthority.CaKeyUsage,
                DevCertificateAuthority.FlagAddext, DevCertificateAuthority.NameConstraintsPrefix + baseDomain,
            ])
            // Seal the key first: a crash before the certificate lands leaves no CA file, so the next call mints afresh.
            await this.store.Put(keyRef, await readFile(keyFile))
            await mkdir(join(this.rootDir, baseDomain), { recursive: true })
            await rename(stagedCert, certFile)
        }
        finally
        {
            await rm(stage, { recursive: true, force: true })
        }
        return readFile(certFile)
    }

    private async IssueNow(baseDomain: string, hosts: readonly string[]): Promise<IssuedCertificate>
    {
        const caKey = await this.store.Get(DevCertificateAuthority.KeyRefOf(baseDomain))
        if (caKey === undefined)
        {
            throw new DevCaKeyMissingError()
        }
        const stage = await this.NewStage()
        try
        {
            const caKeyFile = join(stage, DevCertificateAuthority.CaKeyFile)
            const caCertFile = join(stage, DevCertificateAuthority.CaCertFile)
            const leafKeyFile = join(stage, DevCertificateAuthority.LeafKeyFile)
            const csrFile = join(stage, DevCertificateAuthority.LeafCsrFile)
            const leafCertFile = join(stage, DevCertificateAuthority.LeafCertFile)
            const extFile = join(stage, DevCertificateAuthority.LeafExtFile)
            await writeFile(caKeyFile, caKey, { mode: DevCertificateAuthority.KeyMode })
            await chmod(caKeyFile, DevCertificateAuthority.KeyMode)
            await writeFile(caCertFile, await readFile(this.CaFileOf(baseDomain)))
            const san = DevCertificateAuthority.SanPrefix + hosts.map(h => DevCertificateAuthority.DnsPrefix + h).join(DevCertificateAuthority.SanSeparator)
            await writeFile(extFile, [san, ...DevCertificateAuthority.LeafExtensions].join(DevCertificateAuthority.Eol) + DevCertificateAuthority.Eol)
            await this.Run([DevCertificateAuthority.CmdReq, DevCertificateAuthority.FlagNewkey, DevCertificateAuthority.KeySpec, DevCertificateAuthority.FlagNodes,
                DevCertificateAuthority.FlagKeyout, leafKeyFile, DevCertificateAuthority.FlagOut, csrFile,
                DevCertificateAuthority.FlagSubj, DevCertificateAuthority.SubjectPrefix + hosts[0]])
            await chmod(leafKeyFile, DevCertificateAuthority.KeyMode)
            await this.Run([DevCertificateAuthority.CmdX509, DevCertificateAuthority.FlagReq, DevCertificateAuthority.FlagIn, csrFile,
                DevCertificateAuthority.FlagCa, caCertFile, DevCertificateAuthority.FlagCaKey, caKeyFile, DevCertificateAuthority.FlagCaCreateSerial,
                DevCertificateAuthority.FlagOut, leafCertFile, DevCertificateAuthority.FlagDays, DevCertificateAuthority.LeafDays,
                DevCertificateAuthority.FlagExtfile, extFile])
            return { cert: await readFile(leafCertFile), key: await readFile(leafKeyFile) }
        }
        finally
        {
            await rm(stage, { recursive: true, force: true })
        }
    }

    private async NewStage(): Promise<string>
    {
        await mkdir(this.rootDir, { recursive: true })
        const stage = await mkdtemp(join(this.rootDir, DevCertificateAuthority.StagingPrefix))
        await chmod(stage, DevCertificateAuthority.DirMode)
        return stage
    }

    /**
     * Removes staging dirs a crashed run left behind (they may hold a transient CA key). Only dirs older than
     * StaleStagingMs go, so a second instance or process on the same rootDir never loses its live staging.
     */
    private async SweepStaging(): Promise<void>
    {
        try
        {
            for (const entry of await readdir(this.rootDir))
            {
                if (!entry.startsWith(DevCertificateAuthority.StagingPrefix))
                {
                    continue
                }
                const dir = join(this.rootDir, entry)
                const info = await stat(dir)
                if (Date.now() - info.mtimeMs > DevCertificateAuthority.StaleStagingMs)
                {
                    await rm(dir, { recursive: true, force: true })
                }
            }
        }
        catch
        {
            // root absent or an entry vanished concurrently: nothing to sweep.
        }
    }

    private static async ReadIfPresent(file: string): Promise<Buffer | undefined>
    {
        try
        {
            return await readFile(file)
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code === DevCertificateAuthority.NotFoundCode)
            {
                return undefined
            }
            throw err
        }
    }

    private Run(args: string[]): Promise<void>
    {
        return new Promise((resolve, reject) =>
        {
            execFile(this.openssl, args, { windowsHide: true }, err =>
            {
                if (err === null)
                {
                    resolve()
                    return
                }
                reject(new DevCaError(DevCertificateAuthority.OpensslFailed + err.message))
            })
        })
    }
}
