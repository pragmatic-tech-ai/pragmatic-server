import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OperatorIdentity, OperatorBootstrapError } from '../operator-identity.js'

class OperatorIdentityFixture
{
    public static readonly Email = 'op@control-plane.test'
    public static readonly Password = 'pw-correct-horse'
    private static readonly TempPrefix = 'op-'
    private static readonly IdentityDir = 'identity'
    private static readonly KeyFile = 'master.key'

    public static Compose(root: string, initialPassword: string | undefined): Promise<OperatorIdentity>
    {
        return OperatorIdentity.Compose({
            identityRoot: join(root, OperatorIdentityFixture.IdentityDir),
            masterKeyFile: join(root, OperatorIdentityFixture.KeyFile),
            operatorEmail: OperatorIdentityFixture.Email,
            initialPassword
        })
    }

    public static async WithRoot(body: (root: string) => Promise<void>): Promise<void>
    {
        const root = mkdtempSync(join(tmpdir(), OperatorIdentityFixture.TempPrefix))
        try
        {
            await body(root)
        }
        finally
        {
            rmSync(root, { recursive: true, force: true })
        }
    }
}

describe('OperatorIdentity', () =>
{
    it('authenticates and round-trips a session', async () =>
    {
        await OperatorIdentityFixture.WithRoot(async root =>
        {
            const identity = await OperatorIdentityFixture.Compose(root, OperatorIdentityFixture.Password)
            assert.equal(await identity.Authenticate(OperatorIdentityFixture.Email, 'wrong'), null)
            const session = await identity.Authenticate(OperatorIdentityFixture.Email, OperatorIdentityFixture.Password)
            assert.notEqual(session, null)
            const principal = await identity.ValidateToken(session!.token)
            assert.equal(principal?.email, OperatorIdentityFixture.Email)
            await identity.Revoke(session!.token)
            assert.equal(await identity.ValidateToken(session!.token), null)
        })
    })

    it('is idempotent across restarts', async () =>
    {
        await OperatorIdentityFixture.WithRoot(async root =>
        {
            await OperatorIdentityFixture.Compose(root, OperatorIdentityFixture.Password)
            const again = await OperatorIdentityFixture.Compose(root, undefined)
            const session = await again.Authenticate(OperatorIdentityFixture.Email, OperatorIdentityFixture.Password)
            assert.notEqual(session, null)
        })
    })

    it('fails fast on a fresh dir without a password', async () =>
    {
        await OperatorIdentityFixture.WithRoot(async root =>
        {
            await assert.rejects(() => OperatorIdentityFixture.Compose(root, undefined), OperatorBootstrapError)
        })
    })

    it('rejects a garbage token', async () =>
    {
        await OperatorIdentityFixture.WithRoot(async root =>
        {
            const identity = await OperatorIdentityFixture.Compose(root, OperatorIdentityFixture.Password)
            assert.equal(await identity.ValidateToken('not-a-real-token'), null)
        })
    })
})
