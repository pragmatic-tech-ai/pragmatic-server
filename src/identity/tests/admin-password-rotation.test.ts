import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthMethod, PresentedSecret, Credential, AuthenticatedResult } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'

interface IRotationDirs
{
    identityRoot: string
    packagesRoot: string
    keyEnv: string
}

class RotationFixture
{
    private static readonly PasswordRef = 't1/bootstrap/admin'
    private static readonly Email = 'admin@x.io'
    private static readonly KeyEnv = 'PS_ROT_KEY'

    public static Dirs(): IRotationDirs
    {
        const identityRoot = mkdtempSync(join(tmpdir(), 'ps-rot-id-'))
        const packagesRoot = mkdtempSync(join(tmpdir(), 'ps-rot-pkg-'))
        const keyEnv = RotationFixture.KeyEnv
        process.env[keyEnv] = randomBytes(32).toString('base64')
        return { identityRoot, packagesRoot, keyEnv }
    }

    public static Cleanup(d: IRotationDirs): void
    {
        rmSync(d.identityRoot, { recursive: true, force: true })
        rmSync(d.packagesRoot, { recursive: true, force: true })
        delete process.env[d.keyEnv]
    }

    public static Options(d: IRotationDirs, allowRotation: boolean)
    {
        return {
            packagesRoot: d.packagesRoot,
            identity: {
                identityRoot: d.identityRoot,
                masterKey: { base64Env: d.keyEnv },
                tenant: { id: 't1', displayName: 'Tenant One' },
                bootstrap: { adminEmail: RotationFixture.Email, adminPrincipalId: 'admin', adminPasswordRef: RotationFixture.PasswordRef, ownerGrant: true, allowAdminPasswordRotation: allowRotation },
            },
        }
    }

    // Seed the admin at `password`, leaving the store persisted for the next instance.
    public static async Seed(d: IRotationDirs, password: string): Promise<void>
    {
        const server = new PragmaticServer(RotationFixture.Options(d, false))
        await server.Start()
        const pack = await server.Pack()
        await pack.Secrets.Put(RotationFixture.PasswordRef, password)
        await server.SeedBootstrapForTest()
        await server.Dispose()
    }

    // Re-store `provisioned` as the plaintext (or delete it when null), reseed with the flag, then test login.
    public static async LoginAfterReseed(d: IRotationDirs, allowRotation: boolean, provisioned: string | null, attempt: string): Promise<boolean>
    {
        const server = new PragmaticServer(RotationFixture.Options(d, allowRotation))
        await server.Start()
        try
        {
            const pack = await server.Pack()
            if (provisioned !== null)
            {
                await pack.Secrets.Put(RotationFixture.PasswordRef, provisioned)
            }
            else
            {
                await pack.Secrets.Delete(RotationFixture.PasswordRef)
            }
            await server.SeedBootstrapForTest()
            const result = await pack.AuthenticatorFor(AuthMethod.Local)!.Authenticate(new Credential(AuthMethod.Local, RotationFixture.Email), new PresentedSecret(attempt), server.Tenant())
            return result instanceof AuthenticatedResult
        }
        finally
        {
            await server.Dispose()
        }
    }
}

test('flag off: a changed provisioned password does not rotate (original still logs in)', async () =>
{
    const d = RotationFixture.Dirs()
    try
    {
        await RotationFixture.Seed(d, 'pw-old')
        assert.equal(await RotationFixture.LoginAfterReseed(d, false, 'pw-new', 'pw-old'), true)
        assert.equal(await RotationFixture.LoginAfterReseed(d, false, 'pw-new', 'pw-new'), false)
    }
    finally
    {
        RotationFixture.Cleanup(d)
    }
})

test('flag on: a changed provisioned password rotates (new logs in, old rejected)', async () =>
{
    const d = RotationFixture.Dirs()
    try
    {
        await RotationFixture.Seed(d, 'pw-old')
        assert.equal(await RotationFixture.LoginAfterReseed(d, true, 'pw-new', 'pw-new'), true)
        assert.equal(await RotationFixture.LoginAfterReseed(d, true, 'pw-new', 'pw-old'), false)
    }
    finally
    {
        RotationFixture.Cleanup(d)
    }
})

test('flag on, unchanged password: no-op (still logs in)', async () =>
{
    const d = RotationFixture.Dirs()
    try
    {
        await RotationFixture.Seed(d, 'pw-same')
        assert.equal(await RotationFixture.LoginAfterReseed(d, true, 'pw-same', 'pw-same'), true)
    }
    finally
    {
        RotationFixture.Cleanup(d)
    }
})

test('flag on, provisioned plaintext absent: no-op, credential intact (fail-closed)', async () =>
{
    const d = RotationFixture.Dirs()
    try
    {
        await RotationFixture.Seed(d, 'pw-old')
        assert.equal(await RotationFixture.LoginAfterReseed(d, true, null, 'pw-old'), true)
    }
    finally
    {
        RotationFixture.Cleanup(d)
    }
})
