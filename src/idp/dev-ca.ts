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
    private static readonly ValidDays = '3650'
    private static readonly KeySpec = 'rsa:2048'
    private static readonly SanPrefix = 'subjectAltName=DNS:'
    private static readonly SanSuffix = ',IP:127.0.0.1'
    private static readonly BasicConstraints = 'basicConstraints=CA:FALSE'
    private static readonly Eol = '\n'
    private static readonly KeyMode = 0o600
    private static readonly OpensslFailed = 'DevCa: failed to run openssl (is the openssl CLI installed and on PATH?): '

    public static EnsureAt(dir: string, host: string, openssl: string = DevCa.Openssl): DevCaFiles
    {
        if (!DevCa.HostPattern.test(host))
        {
            throw new Error(DevCa.InvalidHost + host)
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
            DevCa.Mint(stage, host, openssl)
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

    private static Mint(d: string, host: string, openssl: string): void
    {
        const p = (f: string): string => join(d, f)
        DevCa.Run(openssl, [DevCa.ReqCmd, DevCa.FlagX509, DevCa.FlagNewkey, DevCa.KeySpec, DevCa.FlagNodes, DevCa.FlagKeyout, p(DevCa.CaKeyFile),
            DevCa.FlagOut, p(DevCa.CaCertFile), DevCa.FlagDays, DevCa.ValidDays, DevCa.FlagSubj, DevCa.CaSubject])
        DevCa.Run(openssl, [DevCa.ReqCmd, DevCa.FlagNewkey, DevCa.KeySpec, DevCa.FlagNodes, DevCa.FlagKeyout, p(DevCa.ServerKeyFile),
            DevCa.FlagOut, p(DevCa.ServerCsrFile), DevCa.FlagSubj, DevCa.SubjectPrefix + host])
        writeFileSync(p(DevCa.ExtFile), DevCa.SanPrefix + host + DevCa.SanSuffix + DevCa.Eol + DevCa.BasicConstraints + DevCa.Eol)
        DevCa.Run(openssl, [DevCa.X509Cmd, DevCa.FlagReq, DevCa.FlagIn, p(DevCa.ServerCsrFile), DevCa.FlagCa, p(DevCa.CaCertFile),
            DevCa.FlagCaKey, p(DevCa.CaKeyFile), DevCa.FlagCaCreateSerial, DevCa.FlagOut, p(DevCa.ServerCertFile),
            DevCa.FlagDays, DevCa.ValidDays, DevCa.FlagExtfile, p(DevCa.ExtFile)])
        chmodSync(p(DevCa.CaKeyFile), DevCa.KeyMode)
        chmodSync(p(DevCa.ServerKeyFile), DevCa.KeyMode)
        rmSync(p(DevCa.CaSerialFile), { force: true })
    }

    private static Run(openssl: string, args: string[]): void
    {
        try
        {
            execFileSync(openssl, args, { stdio: 'pipe' })
        }
        catch (e)
        {
            throw new Error(DevCa.OpensslFailed + (e instanceof Error ? e.message : String(e)))
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
