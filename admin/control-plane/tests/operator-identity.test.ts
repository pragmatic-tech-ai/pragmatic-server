import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OperatorIdentity, OperatorBootstrapError, MasterKeyError, OperatorRole, OperatorExistsError } from '../operator-identity.js'

class OperatorIdentityFixture
{
    public static readonly Email = 'op@control-plane.test'
    public static readonly Password = 'pw-correct-horse'
    public static readonly ReadEmail = 'ro@control-plane.test'
    public static readonly FullEmail = 'full@control-plane.test'
    public static readonly NewPassword = 'pw-new-operator'
    public static readonly OtherPassword = 'pw-DIFFERENT'
    public static readonly BadKeyBytes = 16
    public static readonly SummaryKeys = ['email', 'role']
    private static readonly TempPrefix = 'op-'
    private static readonly IdentityDir = 'identity'
    public static readonly KeyFile = 'master.key'

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
            const again = await OperatorIdentityFixture.Compose(root, OperatorIdentityFixture.OtherPassword)
            assert.notEqual(await again.Authenticate(OperatorIdentityFixture.Email, OperatorIdentityFixture.Password), null)
            assert.equal(await again.Authenticate(OperatorIdentityFixture.Email, OperatorIdentityFixture.OtherPassword), null)
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

    it('rejects a wrong-sized master key', async () =>
    {
        await OperatorIdentityFixture.WithRoot(async root =>
        {
            writeFileSync(join(root, OperatorIdentityFixture.KeyFile), Buffer.alloc(OperatorIdentityFixture.BadKeyBytes))
            await assert.rejects(() => OperatorIdentityFixture.Compose(root, OperatorIdentityFixture.Password), MasterKeyError)
        })
    })

    it('reuses the persisted master key', async () =>
    {
        await OperatorIdentityFixture.WithRoot(async root =>
        {
            await OperatorIdentityFixture.Compose(root, OperatorIdentityFixture.Password)
            const first = readFileSync(join(root, OperatorIdentityFixture.KeyFile))
            await OperatorIdentityFixture.Compose(root, OperatorIdentityFixture.Password)
            assert.ok(first.equals(readFileSync(join(root, OperatorIdentityFixture.KeyFile))))
        })
    })

    it('derives Full for the admin and the granted role for created operators', async () =>
    {
        await OperatorIdentityFixture.WithRoot(async root =>
        {
            const identity = await OperatorIdentityFixture.Compose(root, OperatorIdentityFixture.Password)
            const admin = await identity.Authenticate(OperatorIdentityFixture.Email, OperatorIdentityFixture.Password)
            assert.equal((await identity.ValidateToken(admin!.token))?.role, OperatorRole.Full)
            await identity.CreateOperator(OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.NewPassword, OperatorRole.ReadOnly)
            await identity.CreateOperator(OperatorIdentityFixture.FullEmail, OperatorIdentityFixture.NewPassword, OperatorRole.Full)
            const ro = await identity.Authenticate(OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.NewPassword)
            const full = await identity.Authenticate(OperatorIdentityFixture.FullEmail, OperatorIdentityFixture.NewPassword)
            assert.notEqual(ro, null)
            assert.notEqual(full, null)
            assert.equal((await identity.ValidateToken(ro!.token))?.role, OperatorRole.ReadOnly)
            assert.equal((await identity.ValidateToken(full!.token))?.role, OperatorRole.Full)
            assert.equal(await identity.Authenticate(OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.OtherPassword), null)
        })
    })

    it('rejects a duplicate operator email with OperatorExistsError', async () =>
    {
        await OperatorIdentityFixture.WithRoot(async root =>
        {
            const identity = await OperatorIdentityFixture.Compose(root, OperatorIdentityFixture.Password)
            await identity.CreateOperator(OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.NewPassword, OperatorRole.ReadOnly)
            await assert.rejects(() => identity.CreateOperator(OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.NewPassword, OperatorRole.Full), OperatorExistsError)
            await assert.rejects(() => identity.CreateOperator(OperatorIdentityFixture.Email, OperatorIdentityFixture.NewPassword, OperatorRole.Full), OperatorExistsError)
        })
    })

    it('lists the admin once with the configured email plus created operators', async () =>
    {
        await OperatorIdentityFixture.WithRoot(async root =>
        {
            const identity = await OperatorIdentityFixture.Compose(root, OperatorIdentityFixture.Password)
            await identity.CreateOperator(OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.NewPassword, OperatorRole.ReadOnly)
            const operators = await identity.ListOperators()
            const admins = operators.filter(o => o.email === OperatorIdentityFixture.Email)
            assert.equal(admins.length, 1)
            assert.equal(admins[0].role, OperatorRole.Full)
            const readOnly = operators.filter(o => o.email === OperatorIdentityFixture.ReadEmail)
            assert.equal(readOnly.length, 1)
            assert.equal(readOnly[0].role, OperatorRole.ReadOnly)
            assert.equal(operators.length, 2)
        })
    })

    it('exposes only email and role in each summary', async () =>
    {
        await OperatorIdentityFixture.WithRoot(async root =>
        {
            const identity = await OperatorIdentityFixture.Compose(root, OperatorIdentityFixture.Password)
            await identity.CreateOperator(OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.NewPassword, OperatorRole.ReadOnly)
            for (const summary of await identity.ListOperators())
            {
                assert.deepEqual(Object.keys(summary).sort(), OperatorIdentityFixture.SummaryKeys)
            }
        })
    })

    it('excludes disabled accounts from the roster', async () =>
    {
        await OperatorIdentityFixture.WithRoot(async root =>
        {
            const identity = await OperatorIdentityFixture.Compose(root, OperatorIdentityFixture.Password)
            await identity.CreateOperator(OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.NewPassword, OperatorRole.ReadOnly)
            await identity.CreateOperator(OperatorIdentityFixture.FullEmail, OperatorIdentityFixture.NewPassword, OperatorRole.Full)
            // Private pack/tenant are reached via bracket access: the real account store's Disable is the only disable path.
            const pack = identity['pack']
            const tenant = identity['tenant']
            const account = await pack.Accounts.FindByEmail(tenant, OperatorIdentityFixture.ReadEmail)
            await pack.Accounts.Disable(tenant, account!.PrincipalId)
            const emails = (await identity.ListOperators()).map(o => o.email).sort()
            assert.deepEqual(emails, [OperatorIdentityFixture.FullEmail, OperatorIdentityFixture.Email].sort())
        })
    })
})
