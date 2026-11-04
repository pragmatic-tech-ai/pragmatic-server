import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomBytes, X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    public static readonly NotFoundExit = 1

    public static Script(): string
    {
        return join(import.meta.dirname, ...TrustScriptFixture.ScriptRelative)
    }

    public static Run(...args: string[]): { status: number | null; stdout: string; stderr: string }
    {
        const r = spawnSync(TrustScriptFixture.Shell, [...TrustScriptFixture.ShellArgs, TrustScriptFixture.Script(), ...args], { encoding: 'utf8' })
        return { status: r.status, stdout: r.stdout, stderr: r.stderr }
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
})
