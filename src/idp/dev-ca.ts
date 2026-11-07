import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DevCaFiles
{
    certFile: string
    keyFile: string
    caFile: string
}

export interface IdpTlsRef
{
    certFile: string
    keyFile: string
}

export interface IdpTlsMaterialData
{
    key: Buffer
    cert: Buffer
}

/**
 * A development CA could not mint: an invalid host or base domain, or openssl failed (its own text follows, which names files and
 * hosts but never key material). Named so a caller can show the reason instead of a generic failure.
 */
export class DevCaError extends Error
{
    private static readonly ErrorName = 'DevCaError'

    public constructor(message: string)
    {
        super(message)
        this.name = DevCaError.ErrorName
    }
}

/** Mints a local self-signed CA plus a CA-signed server cert (via the openssl CLI) for the dev IdP. Idempotent. */
export class DevCa
{
    private static readonly Openssl = 'openssl'
    private static readonly HostPattern = /^[A-Za-z0-9.-]+$/
    private static readonly InvalidHost = 'DevCa: invalid host (only letters, digits, dots and hyphens allowed): '
    private static readonly FlagX509 = '-x509'
    private static readonly FlagNewkey = '-newkey'
    private static readonly FlagNodes = '-nodes'
    private static readonly FlagKeyout = '-keyout'
    private static readonly FlagOut = '-out'
    private static readonly FlagDays = '-days'
    private static readonly FlagSubj = '-subj'
    private static readonly FlagReq = '-req'
    private static readonly FlagIn = '-in'
    private static readonly FlagCaKey = '-CAkey'
    private static readonly FlagCaCreateSerial = '-CAcreateserial'
    private static readonly FlagCa = '-CA'
    private static readonly FlagExtfile = '-extfile'
    private static readonly ReqCmd = 'req'
    private static readonly X509Cmd = 'x509'
    private static readonly CaKeyFile = 'ca.key'
    private static readonly CaCertFile = 'ca.crt'
    private static readonly ServerKeyFile = 'server.key'
    private static readonly ServerCsrFile = 'server.csr'
    private static readonly ServerCertFile = 'server.crt'
    private static readonly ExtFile = 'server.ext'
    private static readonly CaSerialFile = 'ca.srl'
    private static readonly StagingPrefix = '.devca-'
    private static readonly CaSubject = '/CN=pragmatic-idp-dev-ca'
    private static readonly SubjectPrefix = '/CN='
    /** X.509 ub-common-name: openssl refuses a longer CN ("string too long"). */
    private static readonly MaxCommonNameLength = 64
    private static readonly LabelSeparator = '.'
    private static readonly ValidDays = '3650'
    private static readonly KeySpec = 'rsa:2048'
    private static readonly SanPrefix = 'subjectAltName='
    private static readonly DnsPrefix = 'DNS:'
    private static readonly SanSeparator = ','
    private static readonly SanSuffix = ',IP:127.0.0.1'
    private static readonly BasicConstraints = 'basicConstraints=CA:FALSE'
    private static readonly FlagAddext = '-addext'
    private static readonly CaBasicConstraints = 'basicConstraints=critical,CA:TRUE,pathlen:0'
    private static readonly CaKeyUsage = 'keyUsage=critical,keyCertSign,cRLSign'
    private static readonly NameConstraintsPrefix = 'nameConstraints=critical,'
    private static readonly PermittedDnsPrefix = 'permitted;DNS:'
    /** The one IP every server cert carries (SanSuffix), as the only permitted IP subtree. */
    private static readonly PermittedLoopback = 'permitted;IP:127.0.0.1/255.255.255.255'
    private static readonly Eol = '\n'
    private static readonly KeyMode = 0o600
    private static readonly OpensslFailed = 'DevCa: failed to run openssl (is the openssl CLI installed and on PATH?): '

    /** `host` is one DNS name, or a list (CN = the first host of at most 64 characters, or the first host's first label when none fits; every one becomes a DNS SAN and a permitted name of the CA). A bare string behaves exactly as a one-element list. */
    public static EnsureAt(dir: string, host: string | readonly string[], openssl: string = DevCa.Openssl): DevCaFiles
    {
        const hosts: readonly string[] = typeof host === 'string' ? [host] : host
        if (hosts.length === 0)
        {
            throw new DevCaError(DevCa.InvalidHost + String(host))
        }
        for (const h of hosts)
        {
            if (!DevCa.HostPattern.test(h))
            {
                throw new DevCaError(DevCa.InvalidHost + h)
            }
        }
        // Sweep any staging dir a prior crashed mint left behind (a hard-kill in the sub-second window before the
        // finally-rmSync) so its transient ca.key cannot persist across restarts. Runs before the idempotency
        // return because a crash after the renames but before rmSync leaves BOTH the runtime files AND the stage.
        DevCa.SweepStaging(dir)
        const result: DevCaFiles = {
            certFile: join(dir, DevCa.ServerCertFile),
            keyFile: join(dir, DevCa.ServerKeyFile),
            caFile: join(dir, DevCa.CaCertFile),
        }
        // ca.key is a mint-time-only artifact (openssl needs it to sign the server cert) and is intentionally NOT
        // persisted; the guard tracks only the three runtime files the IdP serves with.
        if (existsSync(result.certFile) && existsSync(result.keyFile) && existsSync(result.caFile))
        {
            return result
        }
        // Mint into a staging dir, then move into place so a failure never leaves a half-written set.
        mkdirSync(dir, { recursive: true })
        const stage = mkdtempSync(join(dir, DevCa.StagingPrefix))
        try
        {
            DevCa.Mint(stage, hosts, openssl)
            renameSync(join(stage, DevCa.ServerKeyFile), result.keyFile)
            renameSync(join(stage, DevCa.CaCertFile), result.caFile)
            renameSync(join(stage, DevCa.ServerCertFile), result.certFile)
        }
        finally
        {
            rmSync(stage, { recursive: true, force: true })
        }
        return result
    }

    /**
     * Best-effort removal of any `StagingPrefix` dir left inside `dir` by a prior crashed mint. No-ops when `dir`
     * is absent or not writable (the in-cluster TLS mount is read-only and never minted into, so it holds no
     * staging dir to sweep); never throws, so a sweep failure cannot break an otherwise-valid EnsureAt.
     */
    private static SweepStaging(dir: string): void
    {
        try
        {
            for (const entry of readdirSync(dir))
            {
                if (entry.startsWith(DevCa.StagingPrefix))
                {
                    rmSync(join(dir, entry), { recursive: true, force: true })
                }
            }
        }
        catch
        {
            // dir absent or unreadable: nothing to sweep.
        }
    }

    private static Mint(d: string, hosts: readonly string[], openssl: string): void
    {
        const p = (f: string): string => join(d, f)
        DevCa.Run(openssl, [DevCa.ReqCmd, DevCa.FlagX509, DevCa.FlagNewkey, DevCa.KeySpec, DevCa.FlagNodes, DevCa.FlagKeyout, p(DevCa.CaKeyFile),
            DevCa.FlagOut, p(DevCa.CaCertFile), DevCa.FlagDays, DevCa.ValidDays, DevCa.FlagSubj, DevCa.CaSubject,
            DevCa.FlagAddext, DevCa.CaBasicConstraints, DevCa.FlagAddext, DevCa.CaKeyUsage, DevCa.FlagAddext, DevCa.NameConstraintsOf(hosts)])
        DevCa.Run(openssl, [DevCa.ReqCmd, DevCa.FlagNewkey, DevCa.KeySpec, DevCa.FlagNodes, DevCa.FlagKeyout, p(DevCa.ServerKeyFile),
            DevCa.FlagOut, p(DevCa.ServerCsrFile), DevCa.FlagSubj, DevCa.SubjectPrefix + DevCa.CommonNameOf(hosts)])
        writeFileSync(p(DevCa.ExtFile), DevCa.SanPrefix + hosts.map(h => DevCa.DnsPrefix + h).join(DevCa.SanSeparator) + DevCa.SanSuffix + DevCa.Eol + DevCa.BasicConstraints + DevCa.Eol)
        DevCa.Run(openssl, [DevCa.X509Cmd, DevCa.FlagReq, DevCa.FlagIn, p(DevCa.ServerCsrFile), DevCa.FlagCa, p(DevCa.CaCertFile),
            DevCa.FlagCaKey, p(DevCa.CaKeyFile), DevCa.FlagCaCreateSerial, DevCa.FlagOut, p(DevCa.ServerCertFile),
            DevCa.FlagDays, DevCa.ValidDays, DevCa.FlagExtfile, p(DevCa.ExtFile)])
        chmodSync(p(DevCa.CaKeyFile), DevCa.KeyMode)
        chmodSync(p(DevCa.ServerKeyFile), DevCa.KeyMode)
        rmSync(p(DevCa.CaSerialFile), { force: true })
    }

    /**
     * The CA may sign only for the hosts it was minted for (and the loopback IP), so trusting it in an OS store (dev-ca-trust.ps1
     * refuses any CA without a critical name constraint) can never vouch for another site, even if its key leaked during the mint.
     */
    private static NameConstraintsOf(hosts: readonly string[]): string
    {
        return DevCa.NameConstraintsPrefix + [...hosts.map(h => DevCa.PermittedDnsPrefix + h), DevCa.PermittedLoopback].join(DevCa.SanSeparator)
    }

    /**
     * The subject CN for the server cert: the first host that fits X.509's 64-character CN limit, so the CN is itself one of
     * the CA's permitted names. Only when no host fits is it the first host's first DNS label (cut to the limit); clients match
     * the SAN list, which always carries every full host, so that shortened CN changes no verification.
     */
    private static CommonNameOf(hosts: readonly string[]): string
    {
        const fitting = hosts.find(h => h.length <= DevCa.MaxCommonNameLength)
        if (fitting !== undefined)
        {
            return fitting
        }
        return ((hosts[0] as string).split(DevCa.LabelSeparator)[0] as string).slice(0, DevCa.MaxCommonNameLength)
    }

    private static Run(openssl: string, args: string[]): void
    {
        try
        {
            execFileSync(openssl, args, { stdio: 'pipe' })
        }
        catch (e)
        {
            throw new DevCaError(DevCa.OpensslFailed + (e instanceof Error ? e.message : String(e)))
        }
    }
}

/** Loads the IdP's HTTPS server cert + key by file reference. Server cert only; no client-cert auth. */
export class IdpTlsMaterial
{
    public static Load(ref: IdpTlsRef): IdpTlsMaterialData
    {
        return { key: readFileSync(ref.keyFile), cert: readFileSync(ref.certFile) }
    }
}
