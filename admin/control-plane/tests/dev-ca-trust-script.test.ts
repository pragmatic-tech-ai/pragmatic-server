import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomBytes, X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevCa } from '../../../src/idp/dev-ca.js'
import { IdpContainerEnv } from '../idp-container-env.js'
import { SealedSecretStore } from '../sealed-secret-store.js'
import { DevCertificateAuthority } from '../dev-certificate-authority.js'

class TrustScriptFixture
{
    public static readonly Prefix = 'devca-trust-'
    public static readonly Domain = 'localtest.me'
    public static readonly Shell = 'powershell.exe'
    public static readonly ScriptRelative = ['..', 'dev', 'dev-ca-trust.ps1']
    public static readonly ShellArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']
    public static readonly CaFileFlag = '-CaFile'
    public static readonly ThumbprintFlag = '-ShowThumbprint'
    public static readonly InstallFlag = '-Install'
    public static readonly MissingName = 'missing.crt'
    public static readonly ColonPattern = /:/g
    public static readonly UsageExit = 2
    public static readonly WhatIfFlag = '-WhatIf'
    public static readonly RemoveFlag = '-Remove'
    public static readonly ThumbprintParam = '-Thumbprint'
    public static readonly CheckDir = 'C:/tmp/followups/ca-script-check'
    public static readonly Openssl = 'openssl'
    public static readonly StoreItemQuery = "Test-Path -LiteralPath ('Cert:\\CurrentUser\\Root\\' + $args[0])"
    public static readonly FirstStoreThumbprintQuery = "(Get-ChildItem Cert:\\CurrentUser\\Root | Select-Object -First 1).Thumbprint"
    public static readonly PlainExts = ['basicConstraints=critical,CA:FALSE']
    public static readonly UnconstrainedCaExts = ['basicConstraints=critical,CA:TRUE']
    public static readonly ZeroThumbprint = '0000000000000000000000000000000000000000'
    public static readonly NotFoundExit = 1

    public static Script(): string
    {
        return join(import.meta.dirname, ...TrustScriptFixture.ScriptRelative)
    }

    public static Run(...args: string[]): { status: number | null; stdout: string; stderr: string }
    {
        const r = spawnSync(TrustScriptFixture.Shell, [...TrustScriptFixture.ShellArgs, TrustScriptFixture.Script(), ...args], { encoding: 'utf8', env: TrustScriptFixture.CleanEnv() })
        return { status: r.status, stdout: r.stdout, stderr: r.stderr }
    }

    // A PowerShell 7 PSModulePath inherited from the launching shell breaks the Cert: drive in Windows PowerShell 5.1.
    public static CleanEnv(): NodeJS.ProcessEnv
    {
        const env = { ...process.env }
        delete env.PSModulePath
        return env
    }

    public static Query(command: string, ...args: string[]): string
    {
        const r = spawnSync(TrustScriptFixture.Shell, ['-NoProfile', '-Command', command, ...args], { encoding: 'utf8', env: TrustScriptFixture.CleanEnv() })
        return r.stdout.trim()
    }

    public static InStore(thumbprint: string): boolean
    {
        return TrustScriptFixture.Query(`& { ${TrustScriptFixture.StoreItemQuery} }`, thumbprint) === 'True'
    }

    public static async WithOpenssl(exts: string[], body: (certFile: string) => Promise<void>): Promise<void>
    {
        await mkdir(TrustScriptFixture.CheckDir, { recursive: true })
        const dir = await mkdtemp(join(TrustScriptFixture.CheckDir, 'c-'))
        try
        {
            const certFile = join(dir, 'c.crt')
            const args = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'c.key'), '-out', certFile, '-days', '2', '-subj', '/CN=throwaway-test']
            for (const e of exts)
            {
                args.push('-addext', e)
            }
            const r = spawnSync(TrustScriptFixture.Openssl, args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
            assert.equal(r.status, 0, r.stderr)
            await body(certFile)
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }

    public static async With(body: (caFile: string, pem: Buffer, dir: string) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), TrustScriptFixture.Prefix))
        try
        {
            const store = await SealedSecretStore.Open(join(dir, SealedSecretStore.FileName), randomBytes(32))
            const ca = new DevCertificateAuthority(join(dir, DevCertificateAuthority.DirName), store)
            const pem = await ca.EnsureCa(TrustScriptFixture.Domain)
            await body(ca.CaFileOf(TrustScriptFixture.Domain), pem, dir)
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }
}

// Never runs -Install or -Remove: those change the real trust store.
describe('dev-ca-trust.ps1', { skip: process.platform !== 'win32' }, () =>
{
    test('-ShowThumbprint prints the uppercase SHA-1 thumbprint of the CA', async () =>
    {
        await TrustScriptFixture.With(async (caFile, pem) =>
        {
            const r = TrustScriptFixture.Run(TrustScriptFixture.CaFileFlag, caFile, TrustScriptFixture.ThumbprintFlag)
            assert.equal(r.status, 0)
            assert.equal(r.stdout.trim(), new X509Certificate(pem).fingerprint.replace(TrustScriptFixture.ColonPattern, ''))
        })
    })

    test('no switch exits 2 with a usage line', async () =>
    {
        await TrustScriptFixture.With(async (caFile) =>
        {
            const r = TrustScriptFixture.Run(TrustScriptFixture.CaFileFlag, caFile)
            assert.equal(r.status, TrustScriptFixture.UsageExit)
            assert.match(r.stderr, /usage/)
        })
    })

    test('two switches exit 2 before touching any store', async () =>
    {
        await TrustScriptFixture.With(async (caFile) =>
        {
            const r = TrustScriptFixture.Run(TrustScriptFixture.CaFileFlag, caFile, TrustScriptFixture.ThumbprintFlag, TrustScriptFixture.InstallFlag)
            assert.equal(r.status, TrustScriptFixture.UsageExit)
        })
    })

    test('a missing CA file exits 1', async () =>
    {
        await TrustScriptFixture.With(async (_caFile, _pem, dir) =>
        {
            const r = TrustScriptFixture.Run(TrustScriptFixture.CaFileFlag, join(dir, TrustScriptFixture.MissingName), TrustScriptFixture.ThumbprintFlag)
            assert.equal(r.status, TrustScriptFixture.NotFoundExit)
        })
    })

    test('-Install -WhatIf on the dev CA reports and leaves the store untouched', async () =>
    {
        await TrustScriptFixture.With(async (caFile, pem) =>
        {
            const thumb = new X509Certificate(pem).fingerprint.replace(TrustScriptFixture.ColonPattern, '')
            const before = TrustScriptFixture.InStore(thumb)
            const r = TrustScriptFixture.Run(TrustScriptFixture.CaFileFlag, caFile, TrustScriptFixture.InstallFlag, TrustScriptFixture.WhatIfFlag)
            assert.equal(r.status, 0)
            assert.equal(r.stdout.includes(`would install: ${thumb}`), true)
            assert.equal(TrustScriptFixture.InStore(thumb), before)
        })
    })

    test('-Install -WhatIf accepts the local platform IdP CA and leaves the store untouched', async () =>
    {
        const dir = await mkdtemp(join(tmpdir(), TrustScriptFixture.Prefix))
        try
        {
            const caFile = DevCa.EnsureAt(dir, IdpContainerEnv.ContainerHost).caFile
            const thumb = new X509Certificate(await readFile(caFile)).fingerprint.replace(TrustScriptFixture.ColonPattern, '')
            const before = TrustScriptFixture.InStore(thumb)
            const r = TrustScriptFixture.Run(TrustScriptFixture.CaFileFlag, caFile, TrustScriptFixture.InstallFlag, TrustScriptFixture.WhatIfFlag)
            assert.equal(r.status, 0, r.stderr)
            assert.equal(r.stdout.includes(`would install: ${thumb}`), true)
            assert.equal(TrustScriptFixture.InStore(thumb), before)
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    })

    test('-Install refuses a plain non-CA certificate', async () =>
    {
        await TrustScriptFixture.WithOpenssl(TrustScriptFixture.PlainExts, async (certFile) =>
        {
            const r = TrustScriptFixture.Run(TrustScriptFixture.CaFileFlag, certFile, TrustScriptFixture.InstallFlag, TrustScriptFixture.WhatIfFlag)
            assert.equal(r.status, TrustScriptFixture.NotFoundExit)
            assert.match(r.stderr, /refusing: .* is not a name-constrained CA/)
        })
    })

    test('-Install refuses a CA without name constraints', async () =>
    {
        await TrustScriptFixture.WithOpenssl(TrustScriptFixture.UnconstrainedCaExts, async (certFile) =>
        {
            const r = TrustScriptFixture.Run(TrustScriptFixture.CaFileFlag, certFile, TrustScriptFixture.InstallFlag, TrustScriptFixture.WhatIfFlag)
            assert.equal(r.status, TrustScriptFixture.NotFoundExit)
            assert.match(r.stderr, /refusing: .* is not a name-constrained CA/)
        })
    })

    test('-Remove -WhatIf for a certificate that is not installed says so', async () =>
    {
        await TrustScriptFixture.With(async (caFile, pem) =>
        {
            const thumb = new X509Certificate(pem).fingerprint.replace(TrustScriptFixture.ColonPattern, '')
            const r = TrustScriptFixture.Run(TrustScriptFixture.CaFileFlag, caFile, TrustScriptFixture.RemoveFlag, TrustScriptFixture.WhatIfFlag)
            assert.equal(r.status, 0)
            assert.equal(r.stdout.includes(`not installed: ${thumb}`), true)
            assert.equal(TrustScriptFixture.InStore(thumb), false)
        })
    })

    test('-Remove -WhatIf -Thumbprint on an installed root reports and keeps it', async () =>
    {
        // Uses an existing machine root purely as read-only data; -WhatIf guarantees nothing is removed.
        const thumb = TrustScriptFixture.Query(TrustScriptFixture.FirstStoreThumbprintQuery)
        assert.match(thumb, /^[0-9A-F]{40}$/)
        const r = TrustScriptFixture.Run(TrustScriptFixture.ThumbprintParam, thumb.toLowerCase(), TrustScriptFixture.RemoveFlag, TrustScriptFixture.WhatIfFlag)
        assert.equal(r.status, 0)
        assert.equal(r.stdout.includes(`would remove: ${thumb}`), true)
        assert.equal(TrustScriptFixture.InStore(thumb), true)
    })

    test('-Thumbprint must be 40 hex characters and only works with -Remove', async () =>
    {
        const bad = TrustScriptFixture.Run(TrustScriptFixture.ThumbprintParam, 'xyz', TrustScriptFixture.RemoveFlag, TrustScriptFixture.WhatIfFlag)
        assert.equal(bad.status, TrustScriptFixture.UsageExit)
        const wrongSwitch = TrustScriptFixture.Run(TrustScriptFixture.ThumbprintParam, TrustScriptFixture.ZeroThumbprint, TrustScriptFixture.InstallFlag, TrustScriptFixture.WhatIfFlag)
        assert.equal(wrongSwitch.status, TrustScriptFixture.UsageExit)
        const ok = TrustScriptFixture.Run(TrustScriptFixture.ThumbprintParam, TrustScriptFixture.ZeroThumbprint, TrustScriptFixture.RemoveFlag, TrustScriptFixture.WhatIfFlag)
        assert.equal(ok.status, 0)
        assert.equal(ok.stdout.includes(`not installed: ${TrustScriptFixture.ZeroThumbprint}`), true)
    })
})
