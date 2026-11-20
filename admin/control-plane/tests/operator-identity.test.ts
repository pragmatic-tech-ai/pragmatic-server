import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { Role } from '@pragmatic-tech-ai/pragmatic-identity'
import { OperatorBootstrapError, MasterKeyError, OperatorIdentity, OperatorRole, OperatorExistsError } from '../operator-identity.js'
import { OperatorHarness } from './operator-harness.js'

class OperatorIdentityFixture
{
    public static readonly Email = 'op@control-plane.test'
    public static readonly Password = 'pw-correct-horse'
    public static readonly ReadEmail = 'ro@control-plane.test'
    public static readonly FullEmail = 'full@control-plane.test'
    public static readonly NewPassword = 'pw-new-operator'
    public static readonly OtherPassword = 'pw-DIFFERENT'
    public static readonly BadKeyBytes = 16
    public static readonly SummaryKeys = ['disabled', 'email', 'role']
    private static readonly TempPrefix = 'op-'
    public static readonly KeyFile = 'master.key'
    /** The bootstrap operator's principal id (OperatorIdentity's own, private there). */
    public static readonly AdminPrincipal = 'admin'

    public static Compose(root: string, session: ISqlSession, initialPassword: string | undefined): Promise<OperatorHarness>
    {
        return OperatorHarness.Compose(root, session, OperatorIdentityFixture.Email, initialPassword)
    }

    public static async WithRoot(makeSession: () => Promise<ISqlSession>, body: (root: string, session: ISqlSession) => Promise<void>): Promise<void>
    {
        const session = await makeSession()
        await OperatorHarness.WithRoot(OperatorIdentityFixture.TempPrefix, root => body(root, session))
    }
}

SqlTestSessions.Describe('OperatorIdentity', (makeSession, backend) =>
{
    describe(`OperatorIdentity ${backend}`, () =>
    {
        it('authenticates and round-trips a session', async () =>
        {
            await OperatorIdentityFixture.WithRoot(makeSession, async (root, session) =>
            {
                const identity = await OperatorIdentityFixture.Compose(root, session, OperatorIdentityFixture.Password)
                assert.equal(await identity.SignIn(OperatorIdentityFixture.Email, 'wrong'), null)
                const signedIn = await identity.SignIn(OperatorIdentityFixture.Email, OperatorIdentityFixture.Password)
                assert.notEqual(signedIn, null)
                const principal = await identity.Validate(signedIn!.token)
                assert.equal(principal?.email, OperatorIdentityFixture.Email)
                await identity.SignOut(signedIn!.token)
                assert.equal(await identity.Validate(signedIn!.token), null)
            })
        })

        it('is idempotent across restarts', async () =>
        {
            await OperatorIdentityFixture.WithRoot(makeSession, async (root, session) =>
            {
                await OperatorIdentityFixture.Compose(root, session, OperatorIdentityFixture.Password)
                const again = await OperatorIdentityFixture.Compose(root, session, OperatorIdentityFixture.OtherPassword)
                assert.notEqual(await again.SignIn(OperatorIdentityFixture.Email, OperatorIdentityFixture.Password), null)
                assert.equal(await again.SignIn(OperatorIdentityFixture.Email, OperatorIdentityFixture.OtherPassword), null)
            })
        })

        it('fails fast on a fresh dir without a password', async () =>
        {
            await OperatorIdentityFixture.WithRoot(makeSession, async (root, session) =>
            {
                await assert.rejects(() => OperatorIdentityFixture.Compose(root, session, undefined), OperatorBootstrapError)
            })
        })

        it('rejects a garbage token', async () =>
        {
            await OperatorIdentityFixture.WithRoot(makeSession, async (root, session) =>
            {
                const identity = await OperatorIdentityFixture.Compose(root, session, OperatorIdentityFixture.Password)
                assert.equal(await identity.Validate('not-a-real-token'), null)
            })
        })

        it('rejects a wrong-sized master key', async () =>
        {
            await OperatorIdentityFixture.WithRoot(makeSession, async (root, session) =>
            {
                writeFileSync(join(root, OperatorIdentityFixture.KeyFile), Buffer.alloc(OperatorIdentityFixture.BadKeyBytes))
                await assert.rejects(() => OperatorIdentityFixture.Compose(root, session, OperatorIdentityFixture.Password), MasterKeyError)
            })
        })

        it('refuses to mint a new master key over a database that already holds operators (sealed under the lost key)', async () =>
        {
            await OperatorIdentityFixture.WithRoot(makeSession, async (root, session) =>
            {
                await OperatorIdentityFixture.Compose(root, session, OperatorIdentityFixture.Password)
                rmSync(join(root, OperatorIdentityFixture.KeyFile))
                await assert.rejects(() => OperatorIdentityFixture.Compose(root, session, OperatorIdentityFixture.Password), MasterKeyError)
                assert.equal(existsSync(join(root, OperatorIdentityFixture.KeyFile)), false)
            })
        })

        it('reuses the persisted master key', async () =>
        {
            await OperatorIdentityFixture.WithRoot(makeSession, async (root, session) =>
            {
                await OperatorIdentityFixture.Compose(root, session, OperatorIdentityFixture.Password)
                const first = readFileSync(join(root, OperatorIdentityFixture.KeyFile))
                await OperatorIdentityFixture.Compose(root, session, OperatorIdentityFixture.Password)
                assert.ok(first.equals(readFileSync(join(root, OperatorIdentityFixture.KeyFile))))
            })
        })

        it('repairs a missing Owner grant of the bootstrap operator at the next start (a crash between register and grant)', async () =>
        {
            await OperatorIdentityFixture.WithRoot(makeSession, async (root, session) =>
            {
                const F = OperatorIdentityFixture
                await F.Compose(root, session, F.Password)
                const stores = await OperatorIdentity.OpenStores(session, readFileSync(join(root, F.KeyFile)))
                const realm = OperatorIdentity.Realm()
                for (const grant of await stores.Grants.GrantsFor(F.AdminPrincipal, realm))
                {
                    await stores.Grants.Revoke(grant)
                }
                assert.equal((await stores.Grants.GrantsFor(F.AdminPrincipal, realm)).length, 0)
                const again = await F.Compose(root, session, F.Password)
                assert.ok((await stores.Grants.GrantsFor(F.AdminPrincipal, realm)).some(g => g.Role === Role.Owner))
                const signedIn = await again.SignIn(F.Email, F.Password)
                assert.equal((await again.Validate(signedIn!.token))?.role, OperatorRole.Full)
            })
        })

        it('derives Full for the admin and the granted role for created operators', async () =>
        {
            await OperatorIdentityFixture.WithRoot(makeSession, async (root, session) =>
            {
                const identity = await OperatorIdentityFixture.Compose(root, session, OperatorIdentityFixture.Password)
                const admin = await identity.SignIn(OperatorIdentityFixture.Email, OperatorIdentityFixture.Password)
                assert.equal((await identity.Validate(admin!.token))?.role, OperatorRole.Full)
                await identity.Identity.CreateOperator(OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.NewPassword, OperatorRole.ReadOnly)
                await identity.Identity.CreateOperator(OperatorIdentityFixture.FullEmail, OperatorIdentityFixture.NewPassword, OperatorRole.Full)
                const ro = await identity.SignIn(OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.NewPassword)
                const full = await identity.SignIn(OperatorIdentityFixture.FullEmail, OperatorIdentityFixture.NewPassword)
                assert.notEqual(ro, null)
                assert.notEqual(full, null)
                assert.equal((await identity.Validate(ro!.token))?.role, OperatorRole.ReadOnly)
                assert.equal((await identity.Validate(full!.token))?.role, OperatorRole.Full)
                assert.equal(await identity.SignIn(OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.OtherPassword), null)
            })
        })

        it('rejects a duplicate operator email with OperatorExistsError', async () =>
        {
            await OperatorIdentityFixture.WithRoot(makeSession, async (root, session) =>
            {
                const identity = await OperatorIdentityFixture.Compose(root, session, OperatorIdentityFixture.Password)
                await identity.Identity.CreateOperator(OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.NewPassword, OperatorRole.ReadOnly)
                await assert.rejects(() => identity.Identity.CreateOperator(OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.NewPassword, OperatorRole.Full), OperatorExistsError)
                await assert.rejects(() => identity.Identity.CreateOperator(OperatorIdentityFixture.Email, OperatorIdentityFixture.NewPassword, OperatorRole.Full), OperatorExistsError)
            })
        })

        it('lists the admin once with the configured email plus created operators', async () =>
        {
            await OperatorIdentityFixture.WithRoot(makeSession, async (root, session) =>
            {
                const identity = await OperatorIdentityFixture.Compose(root, session, OperatorIdentityFixture.Password)
                await identity.Identity.CreateOperator(OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.NewPassword, OperatorRole.ReadOnly)
                const operators = await identity.Identity.ListOperators()
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
            await OperatorIdentityFixture.WithRoot(makeSession, async (root, session) =>
            {
                const identity = await OperatorIdentityFixture.Compose(root, session, OperatorIdentityFixture.Password)
                await identity.Identity.CreateOperator(OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.NewPassword, OperatorRole.ReadOnly)
                for (const summary of await identity.Identity.ListOperators())
                {
                    assert.deepEqual(Object.keys(summary).sort(), OperatorIdentityFixture.SummaryKeys)
                }
            })
        })

        it('includes disabled accounts in the roster flagged disabled', async () =>
        {
            await OperatorIdentityFixture.WithRoot(makeSession, async (root, session) =>
            {
                const identity = await OperatorIdentityFixture.Compose(root, session, OperatorIdentityFixture.Password)
                await identity.Identity.CreateOperator(OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.NewPassword, OperatorRole.ReadOnly)
                await identity.Identity.CreateOperator(OperatorIdentityFixture.FullEmail, OperatorIdentityFixture.NewPassword, OperatorRole.Full)
                // Private pack/realm are reached via bracket access: the real account store's Disable is the only disable path.
                const pack = identity.Identity['pack']
                const realm = identity.Identity['realm']
                const account = await pack.Accounts.FindByEmail(realm, OperatorIdentityFixture.ReadEmail)
                await pack.Accounts.Disable(realm, account!.PrincipalId)
                const roster = await identity.Identity.ListOperators()
                assert.deepEqual(roster.map(o => o.email).sort(), [OperatorIdentityFixture.ReadEmail, OperatorIdentityFixture.FullEmail, OperatorIdentityFixture.Email].sort())
                assert.deepEqual(roster.filter(o => o.disabled).map(o => o.email), [OperatorIdentityFixture.ReadEmail])
            })
        })
    })
})
