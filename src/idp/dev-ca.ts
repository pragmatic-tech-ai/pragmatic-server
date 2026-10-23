import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

    public static EnsureAt(dir: string, host: string): DevCaFiles
    {
        const result: DevCaFiles = {
            certFile: join(dir, DevCa.ServerCertFile),
            keyFile: join(dir, DevCa.ServerKeyFile),
            caFile: join(dir, DevCa.CaCertFile),
        }
        if (existsSync(result.certFile) && existsSync(result.keyFile) && existsSync(result.caFile))
        {
            return result
        }
        // Mint into a staging dir, then move into place so a failure never leaves a half-written set.
        const stage = mkdtempSync(join(dir, DevCa.StagingPrefix))
        try
        {
            DevCa.Mint(stage, host)
            renameSync(join(stage, DevCa.CaKeyFile), join(dir, DevCa.CaKeyFile))
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

    private static Mint(d: string, host: string): void
    {
        const p = (f: string): string => join(d, f)
        DevCa.Run([DevCa.ReqCmd, '-x509', '-newkey', DevCa.KeySpec, '-nodes', '-keyout', p(DevCa.CaKeyFile),
            '-out', p(DevCa.CaCertFile), '-days', DevCa.ValidDays, '-subj', DevCa.CaSubject])
        DevCa.Run([DevCa.ReqCmd, '-newkey', DevCa.KeySpec, '-nodes', '-keyout', p(DevCa.ServerKeyFile),
            '-out', p(DevCa.ServerCsrFile), '-subj', DevCa.SubjectPrefix + host])
        writeFileSync(p(DevCa.ExtFile), DevCa.SanPrefix + host + DevCa.SanSuffix + DevCa.Eol + DevCa.BasicConstraints + DevCa.Eol)
        DevCa.Run([DevCa.X509Cmd, '-req', '-in', p(DevCa.ServerCsrFile), '-CA', p(DevCa.CaCertFile),
            '-CAkey', p(DevCa.CaKeyFile), '-CAcreateserial', '-out', p(DevCa.ServerCertFile),
            '-days', DevCa.ValidDays, '-extfile', p(DevCa.ExtFile)])
        chmodSync(p(DevCa.CaKeyFile), DevCa.KeyMode)
        chmodSync(p(DevCa.ServerKeyFile), DevCa.KeyMode)
        rmSync(p(DevCa.CaSerialFile), { force: true })
    }

    private static Run(args: string[]): void
    {
        try
        {
            execFileSync(DevCa.Openssl, args, { stdio: 'pipe' })
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
