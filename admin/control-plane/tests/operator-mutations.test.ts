import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { OperatorRole, OperatorNotFoundError, OperatorSelfLockoutError, OperatorProtectedError } from '../operator-identity.js'
import { OperatorHarness } from './operator-harness.js'

class MutationFixture
{
    public static readonly AdminEmail = 'op@control-plane.test'
    public static readonly AdminPassword = 'pw-correct-horse'
    public static readonly FullEmail = 'full@control-plane.test'
    public static readonly RoEmail = 'ro@control-plane.test'
    public static readonly OperatorPassword = 'pw-operator-initial'
    public static readonly ChangedPassword = 'pw-operator-changed-1'
    public static readonly UnknownEmail = 'nobody@control-plane.test'
    public static readonly MinPasswordLength = 12
    public static readonly ActorSentinel = 'some-actor'
    private static readonly TempPrefix = 'opm-'

    public static async WithIdentity(makeSession: () => Promise<ISqlSession>, body: (id: OperatorHarness) => Promise<void>): Promise<void>
    {
        const session = await makeSession()
        await OperatorHarness.WithRoot(MutationFixture.TempPrefix, async root =>
        {
            await body(await OperatorHarness.Compose(root, session, MutationFixture.AdminEmail, MutationFixture.AdminPassword))
        })
    }

    public static async RoleOf(id: OperatorHarness, email: string): Promise<OperatorRole | undefined>
    {
        return (await id.Identity.ListOperators()).find(o => o.email === email)?.role
    }

    /** Logs in as the operator and returns its principal id (the actor identity the host would pass). */
    public static async PrincipalOf(id: OperatorHarness, email: string, password: string): Promise<string>
    {
        const session = await id.SignIn(email, password)
        assert.ok(session)
        const principal = await id.Validate(session.token)
        assert.ok(principal)
        return principal.principalId
    }
}

SqlTestSessions.Describe('OperatorIdentity mutations', (makeSession, backend) =>
{
    describe(`OperatorIdentity mutations ${backend}`, () =>
    {
        it('promotes and demotes with no lingering Owner grant, idempotent at target', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                await id.Identity.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
                await id.Identity.SetOperatorRole(MutationFixture.RoEmail, OperatorRole.Full, MutationFixture.ActorSentinel)
                assert.equal(await MutationFixture.RoleOf(id, MutationFixture.RoEmail), OperatorRole.Full)
                await id.Identity.SetOperatorRole(MutationFixture.RoEmail, OperatorRole.Full, MutationFixture.ActorSentinel)
                assert.equal(await MutationFixture.RoleOf(id, MutationFixture.RoEmail), OperatorRole.Full)
                await id.Identity.SetOperatorRole(MutationFixture.RoEmail, OperatorRole.ReadOnly, MutationFixture.ActorSentinel)
                assert.equal(await MutationFixture.RoleOf(id, MutationFixture.RoEmail), OperatorRole.ReadOnly)
                await id.Identity.SetOperatorRole(MutationFixture.RoEmail, OperatorRole.ReadOnly, MutationFixture.ActorSentinel)
                assert.equal(await MutationFixture.RoleOf(id, MutationFixture.RoEmail), OperatorRole.ReadOnly)
                await id.Identity.SetOperatorRole(MutationFixture.RoEmail, OperatorRole.Full, MutationFixture.ActorSentinel)
                assert.equal(await MutationFixture.RoleOf(id, MutationFixture.RoEmail), OperatorRole.Full)
            })
        })

        it('demoted operator is ReadOnly on a live token', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                await id.Identity.CreateOperator(MutationFixture.FullEmail, MutationFixture.OperatorPassword, OperatorRole.Full)
                await id.Identity.SetOperatorRole(MutationFixture.FullEmail, OperatorRole.ReadOnly, MutationFixture.ActorSentinel)
                const session = await id.SignIn(MutationFixture.FullEmail, MutationFixture.OperatorPassword)
                assert.ok(session)
                assert.equal((await id.Validate(session.token))?.role, OperatorRole.ReadOnly)
            })
        })

        it('reset password returns a strong new password; old fails, new works', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                await id.Identity.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
                const pw = await id.Identity.ResetOperatorPassword(MutationFixture.RoEmail)
                assert.ok(pw.length >= MutationFixture.MinPasswordLength)
                assert.equal(await id.SignIn(MutationFixture.RoEmail, MutationFixture.OperatorPassword), null)
                assert.ok(await id.SignIn(MutationFixture.RoEmail, pw))
            })
        })

        it('reset password ends every live session of the operator', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                await id.Identity.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
                const a = await id.SignIn(MutationFixture.RoEmail, MutationFixture.OperatorPassword)
                const b = await id.SignIn(MutationFixture.RoEmail, MutationFixture.OperatorPassword)
                const admin = await id.SignIn(MutationFixture.AdminEmail, MutationFixture.AdminPassword)
                assert.ok(a && b && admin)
                await id.Identity.ResetOperatorPassword(MutationFixture.RoEmail)
                assert.equal(await id.Validate(a.token), null)
                assert.equal(await id.Validate(b.token), null)
                assert.ok(await id.Validate(admin.token), 'another operator keeps their session')
            })
        })

        it('a reset of oneself ends the caller own sessions too (documented: the reset is not self-exempt)', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                const own = await id.SignIn(MutationFixture.AdminEmail, MutationFixture.AdminPassword)
                assert.ok(own)
                await id.Identity.ResetOperatorPassword(MutationFixture.AdminEmail)
                assert.equal(await id.Validate(own.token), null)
            })
        })

        it('change own password: verifies the current one and rotates it; the session rotate then ends every old session and issues a fresh one', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                await id.Identity.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
                const mine = await id.SignIn(MutationFixture.RoEmail, MutationFixture.OperatorPassword)
                const elsewhere = await id.SignIn(MutationFixture.RoEmail, MutationFixture.OperatorPassword)
                const admin = await id.SignIn(MutationFixture.AdminEmail, MutationFixture.AdminPassword)
                assert.ok(mine && elsewhere && admin)
                const principalId = (await id.Validate(mine.token))!.principalId
                assert.equal(await id.Identity.ChangeOwnPassword(principalId, MutationFixture.OperatorPassword, MutationFixture.ChangedPassword), true)
                // The console then rotates the caller's sessions: every old one ends, the caller gets one fresh session.
                const rotated = await id.Sessions.Store.Rotate(mine.token)
                assert.ok(rotated)
                const fresh = { token: rotated.Token }
                assert.equal((await id.Validate(fresh.token))?.principalId, principalId)
                assert.equal(await id.Validate(mine.token), null)
                assert.equal(await id.Validate(elsewhere.token), null)
                assert.ok(await id.Validate(admin.token))
                assert.equal(await id.SignIn(MutationFixture.RoEmail, MutationFixture.OperatorPassword), null)
                assert.ok(await id.SignIn(MutationFixture.RoEmail, MutationFixture.ChangedPassword))
            })
        })

        it('change own password with a wrong current password changes nothing and ends no session', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                await id.Identity.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
                const mine = await id.SignIn(MutationFixture.RoEmail, MutationFixture.OperatorPassword)
                assert.ok(mine)
                const principalId = (await id.Validate(mine.token))!.principalId
                assert.equal(await id.Identity.ChangeOwnPassword(principalId, 'not-the-password', MutationFixture.ChangedPassword), false)
                assert.ok(await id.Validate(mine.token))
                assert.ok(await id.SignIn(MutationFixture.RoEmail, MutationFixture.OperatorPassword))
            })
        })

        it('change own password checks the current password of the session principal, not anyone else', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                await id.Identity.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
                const admin = await id.SignIn(MutationFixture.AdminEmail, MutationFixture.AdminPassword)
                assert.ok(admin)
                const adminId = (await id.Validate(admin.token))!.principalId
                assert.equal(await id.Identity.ChangeOwnPassword(adminId, MutationFixture.OperatorPassword, MutationFixture.ChangedPassword), false)
                assert.equal(await id.Identity.ChangeOwnPassword('no-such-principal', MutationFixture.OperatorPassword, MutationFixture.ChangedPassword), false)
                assert.ok(await id.SignIn(MutationFixture.RoEmail, MutationFixture.OperatorPassword))
                assert.ok(await id.SignIn(MutationFixture.AdminEmail, MutationFixture.AdminPassword))
                assert.ok(await id.Validate(admin.token))
            })
        })



        it('the bootstrap admin can change their own password', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                const admin = await id.SignIn(MutationFixture.AdminEmail, MutationFixture.AdminPassword)
                assert.ok(admin)
                const adminId = (await id.Validate(admin.token))!.principalId
                assert.ok(await id.Identity.ChangeOwnPassword(adminId, MutationFixture.AdminPassword, MutationFixture.ChangedPassword))
                assert.ok(await id.SignIn(MutationFixture.AdminEmail, MutationFixture.ChangedPassword))
            })
        })

        it('an invited operator session reports the email they sign in with, not their principal id', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                await id.Identity.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
                const session = await id.SignIn(MutationFixture.RoEmail, MutationFixture.OperatorPassword)
                assert.ok(session)
                assert.equal((await id.Validate(session.token))?.email, MutationFixture.RoEmail)
            })
        })

        it('reset password is allowed for the bootstrap admin', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                const pw = await id.Identity.ResetOperatorPassword(MutationFixture.AdminEmail)
                assert.equal(await id.SignIn(MutationFixture.AdminEmail, MutationFixture.AdminPassword), null)
                assert.ok(await id.SignIn(MutationFixture.AdminEmail, pw))
            })
        })

        it('disable blocks authentication, enable restores it, roster shows disabled', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                await id.Identity.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
                await id.Identity.SetOperatorDisabled(MutationFixture.RoEmail, true, MutationFixture.ActorSentinel)
                assert.equal(await id.SignIn(MutationFixture.RoEmail, MutationFixture.OperatorPassword), null)
                const row = (await id.Identity.ListOperators()).find(o => o.email === MutationFixture.RoEmail)
                assert.ok(row)
                assert.equal(row.disabled, true)
                await id.Identity.SetOperatorDisabled(MutationFixture.RoEmail, false, MutationFixture.ActorSentinel)
                assert.ok(await id.SignIn(MutationFixture.RoEmail, MutationFixture.OperatorPassword))
                const row2 = (await id.Identity.ListOperators()).find(o => o.email === MutationFixture.RoEmail)
                assert.equal(row2?.disabled, false)
            })
        })

        it('disabling an operator drops their live session', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                await id.Identity.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
                const session = await id.SignIn(MutationFixture.RoEmail, MutationFixture.OperatorPassword)
                assert.ok(session)
                assert.ok(await id.Validate(session.token))
                await id.Identity.SetOperatorDisabled(MutationFixture.RoEmail, true, MutationFixture.ActorSentinel)
                assert.equal(await id.Validate(session.token), null)
            })
        })

        it('demoting an already-ReadOnly self is a no-op, not a lockout', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                await id.Identity.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
                const self = await MutationFixture.PrincipalOf(id, MutationFixture.RoEmail, MutationFixture.OperatorPassword)
                await id.Identity.SetOperatorRole(MutationFixture.RoEmail, OperatorRole.ReadOnly, self)
                assert.equal(await MutationFixture.RoleOf(id, MutationFixture.RoEmail), OperatorRole.ReadOnly)
            })
        })

        it('revoke sessions invalidates previously issued tokens', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                await id.Identity.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
                const session = await id.SignIn(MutationFixture.RoEmail, MutationFixture.OperatorPassword)
                assert.ok(session)
                assert.ok(await id.Validate(session.token))
                await id.Identity.RevokeOperatorSessions(MutationFixture.RoEmail)
                assert.equal(await id.Validate(session.token), null)
            })
        })

        it('guards: bootstrap admin is protected for role and disable', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                await assert.rejects(id.Identity.SetOperatorRole(MutationFixture.AdminEmail, OperatorRole.ReadOnly, MutationFixture.ActorSentinel), OperatorProtectedError)
                await assert.rejects(id.Identity.SetOperatorDisabled(MutationFixture.AdminEmail, true, MutationFixture.ActorSentinel), OperatorProtectedError)
            })
        })

        it('guards: self-lockout on demote and disable', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                await id.Identity.CreateOperator(MutationFixture.FullEmail, MutationFixture.OperatorPassword, OperatorRole.Full)
                const self = await MutationFixture.PrincipalOf(id, MutationFixture.FullEmail, MutationFixture.OperatorPassword)
                await assert.rejects(id.Identity.SetOperatorRole(MutationFixture.FullEmail, OperatorRole.ReadOnly, self), OperatorSelfLockoutError)
                await assert.rejects(id.Identity.SetOperatorDisabled(MutationFixture.FullEmail, true, self), OperatorSelfLockoutError)
                assert.equal(await MutationFixture.RoleOf(id, MutationFixture.FullEmail), OperatorRole.Full)
            })
        })

        it('last-Full guard is defense in depth: the protected bootstrap admin always keeps one Full operator', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                await id.Identity.CreateOperator(MutationFixture.FullEmail, MutationFixture.OperatorPassword, OperatorRole.Full)
                await id.Identity.SetOperatorRole(MutationFixture.FullEmail, OperatorRole.ReadOnly, MutationFixture.ActorSentinel)
                await id.Identity.SetOperatorDisabled(MutationFixture.FullEmail, true, MutationFixture.ActorSentinel)
                assert.equal(await MutationFixture.RoleOf(id, MutationFixture.AdminEmail), OperatorRole.Full)
                assert.ok((await id.Identity.ListOperators()).some(o => o.role === OperatorRole.Full && !o.disabled))
            })
        })

        it('unknown email throws OperatorNotFoundError on every mutation', async () =>
        {
            await MutationFixture.WithIdentity(makeSession, async id =>
            {
                const u = MutationFixture.UnknownEmail
                await assert.rejects(id.Identity.SetOperatorRole(u, OperatorRole.Full, MutationFixture.ActorSentinel), OperatorNotFoundError)
                await assert.rejects(id.Identity.ResetOperatorPassword(u), OperatorNotFoundError)
                await assert.rejects(id.Identity.SetOperatorDisabled(u, true, MutationFixture.ActorSentinel), OperatorNotFoundError)
                await assert.rejects(id.Identity.RevokeOperatorSessions(u), OperatorNotFoundError)
            })
        })
    })
})
