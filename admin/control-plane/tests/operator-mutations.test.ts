import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OperatorIdentity, OperatorRole, OperatorNotFoundError, OperatorSelfLockoutError, OperatorProtectedError } from '../operator-identity.js'

class MutationFixture
{
    public static readonly AdminEmail = 'op@control-plane.test'
    public static readonly AdminPassword = 'pw-correct-horse'
    public static readonly FullEmail = 'full@control-plane.test'
    public static readonly RoEmail = 'ro@control-plane.test'
    public static readonly OperatorPassword = 'pw-operator-initial'
    public static readonly UnknownEmail = 'nobody@control-plane.test'
    public static readonly MinPasswordLength = 12
    public static readonly ActorSentinel = 'some-actor'
    private static readonly TempPrefix = 'opm-'
    private static readonly IdentityDir = 'identity'
    private static readonly KeyFile = 'master.key'

    public static async WithIdentity(body: (id: OperatorIdentity) => Promise<void>): Promise<void>
    {
        const root = mkdtempSync(join(tmpdir(), MutationFixture.TempPrefix))
        try
        {
            const id = await OperatorIdentity.Compose({
                identityRoot: join(root, MutationFixture.IdentityDir),
                masterKeyFile: join(root, MutationFixture.KeyFile),
                operatorEmail: MutationFixture.AdminEmail,
                initialPassword: MutationFixture.AdminPassword
            })
            await body(id)
        }
        finally
        {
            rmSync(root, { recursive: true, force: true })
        }
    }

    public static async RoleOf(id: OperatorIdentity, email: string): Promise<OperatorRole | undefined>
    {
        return (await id.ListOperators()).find(o => o.email === email)?.role
    }

    /** Logs in as the operator and returns its principal id (the actor identity the host would pass). */
    public static async PrincipalOf(id: OperatorIdentity, email: string, password: string): Promise<string>
    {
        const session = await id.Authenticate(email, password)
        assert.ok(session)
        const principal = await id.ValidateToken(session.token)
        assert.ok(principal)
        return principal.principalId
    }
}

describe('OperatorIdentity mutations', () =>
{
    it('promotes and demotes with no lingering Owner grant, idempotent at target', async () =>
    {
        await MutationFixture.WithIdentity(async id =>
        {
            await id.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
            await id.SetOperatorRole(MutationFixture.RoEmail, OperatorRole.Full, MutationFixture.ActorSentinel)
            assert.equal(await MutationFixture.RoleOf(id, MutationFixture.RoEmail), OperatorRole.Full)
            await id.SetOperatorRole(MutationFixture.RoEmail, OperatorRole.Full, MutationFixture.ActorSentinel)
            assert.equal(await MutationFixture.RoleOf(id, MutationFixture.RoEmail), OperatorRole.Full)
            await id.SetOperatorRole(MutationFixture.RoEmail, OperatorRole.ReadOnly, MutationFixture.ActorSentinel)
            assert.equal(await MutationFixture.RoleOf(id, MutationFixture.RoEmail), OperatorRole.ReadOnly)
            await id.SetOperatorRole(MutationFixture.RoEmail, OperatorRole.ReadOnly, MutationFixture.ActorSentinel)
            assert.equal(await MutationFixture.RoleOf(id, MutationFixture.RoEmail), OperatorRole.ReadOnly)
            await id.SetOperatorRole(MutationFixture.RoEmail, OperatorRole.Full, MutationFixture.ActorSentinel)
            assert.equal(await MutationFixture.RoleOf(id, MutationFixture.RoEmail), OperatorRole.Full)
        })
    })

    it('demoted operator is ReadOnly on a live token', async () =>
    {
        await MutationFixture.WithIdentity(async id =>
        {
            await id.CreateOperator(MutationFixture.FullEmail, MutationFixture.OperatorPassword, OperatorRole.Full)
            await id.SetOperatorRole(MutationFixture.FullEmail, OperatorRole.ReadOnly, MutationFixture.ActorSentinel)
            const session = await id.Authenticate(MutationFixture.FullEmail, MutationFixture.OperatorPassword)
            assert.ok(session)
            assert.equal((await id.ValidateToken(session.token))?.role, OperatorRole.ReadOnly)
        })
    })

    it('reset password returns a strong new password; old fails, new works', async () =>
    {
        await MutationFixture.WithIdentity(async id =>
        {
            await id.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
            const pw = await id.ResetOperatorPassword(MutationFixture.RoEmail)
            assert.ok(pw.length >= MutationFixture.MinPasswordLength)
            assert.equal(await id.Authenticate(MutationFixture.RoEmail, MutationFixture.OperatorPassword), null)
            assert.ok(await id.Authenticate(MutationFixture.RoEmail, pw))
        })
    })

    it('reset password is allowed for the bootstrap admin', async () =>
    {
        await MutationFixture.WithIdentity(async id =>
        {
            const pw = await id.ResetOperatorPassword(MutationFixture.AdminEmail)
            assert.equal(await id.Authenticate(MutationFixture.AdminEmail, MutationFixture.AdminPassword), null)
            assert.ok(await id.Authenticate(MutationFixture.AdminEmail, pw))
        })
    })

    it('disable blocks authentication, enable restores it, roster shows disabled', async () =>
    {
        await MutationFixture.WithIdentity(async id =>
        {
            await id.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
            await id.SetOperatorDisabled(MutationFixture.RoEmail, true, MutationFixture.ActorSentinel)
            assert.equal(await id.Authenticate(MutationFixture.RoEmail, MutationFixture.OperatorPassword), null)
            const row = (await id.ListOperators()).find(o => o.email === MutationFixture.RoEmail)
            assert.ok(row)
            assert.equal(row.disabled, true)
            await id.SetOperatorDisabled(MutationFixture.RoEmail, false, MutationFixture.ActorSentinel)
            assert.ok(await id.Authenticate(MutationFixture.RoEmail, MutationFixture.OperatorPassword))
            const row2 = (await id.ListOperators()).find(o => o.email === MutationFixture.RoEmail)
            assert.equal(row2?.disabled, false)
        })
    })

    it('disabling an operator drops their live session', async () =>
    {
        await MutationFixture.WithIdentity(async id =>
        {
            await id.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
            const session = await id.Authenticate(MutationFixture.RoEmail, MutationFixture.OperatorPassword)
            assert.ok(session)
            assert.ok(await id.ValidateToken(session.token))
            await id.SetOperatorDisabled(MutationFixture.RoEmail, true, MutationFixture.ActorSentinel)
            assert.equal(await id.ValidateToken(session.token), null)
        })
    })

    it('demoting an already-ReadOnly self is a no-op, not a lockout', async () =>
    {
        await MutationFixture.WithIdentity(async id =>
        {
            await id.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
            const self = await MutationFixture.PrincipalOf(id, MutationFixture.RoEmail, MutationFixture.OperatorPassword)
            await id.SetOperatorRole(MutationFixture.RoEmail, OperatorRole.ReadOnly, self)
            assert.equal(await MutationFixture.RoleOf(id, MutationFixture.RoEmail), OperatorRole.ReadOnly)
        })
    })

    it('revoke sessions invalidates previously issued tokens', async () =>
    {
        await MutationFixture.WithIdentity(async id =>
        {
            await id.CreateOperator(MutationFixture.RoEmail, MutationFixture.OperatorPassword, OperatorRole.ReadOnly)
            const session = await id.Authenticate(MutationFixture.RoEmail, MutationFixture.OperatorPassword)
            assert.ok(session)
            assert.ok(await id.ValidateToken(session.token))
            await id.RevokeOperatorSessions(MutationFixture.RoEmail)
            assert.equal(await id.ValidateToken(session.token), null)
        })
    })

    it('guards: bootstrap admin is protected for role and disable', async () =>
    {
        await MutationFixture.WithIdentity(async id =>
        {
            await assert.rejects(id.SetOperatorRole(MutationFixture.AdminEmail, OperatorRole.ReadOnly, MutationFixture.ActorSentinel), OperatorProtectedError)
            await assert.rejects(id.SetOperatorDisabled(MutationFixture.AdminEmail, true, MutationFixture.ActorSentinel), OperatorProtectedError)
        })
    })

    it('guards: self-lockout on demote and disable', async () =>
    {
        await MutationFixture.WithIdentity(async id =>
        {
            await id.CreateOperator(MutationFixture.FullEmail, MutationFixture.OperatorPassword, OperatorRole.Full)
            const self = await MutationFixture.PrincipalOf(id, MutationFixture.FullEmail, MutationFixture.OperatorPassword)
            await assert.rejects(id.SetOperatorRole(MutationFixture.FullEmail, OperatorRole.ReadOnly, self), OperatorSelfLockoutError)
            await assert.rejects(id.SetOperatorDisabled(MutationFixture.FullEmail, true, self), OperatorSelfLockoutError)
            assert.equal(await MutationFixture.RoleOf(id, MutationFixture.FullEmail), OperatorRole.Full)
        })
    })

    it('last-Full guard is defense in depth: the protected bootstrap admin always keeps one Full operator', async () =>
    {
        await MutationFixture.WithIdentity(async id =>
        {
            await id.CreateOperator(MutationFixture.FullEmail, MutationFixture.OperatorPassword, OperatorRole.Full)
            await id.SetOperatorRole(MutationFixture.FullEmail, OperatorRole.ReadOnly, MutationFixture.ActorSentinel)
            await id.SetOperatorDisabled(MutationFixture.FullEmail, true, MutationFixture.ActorSentinel)
            assert.equal(await MutationFixture.RoleOf(id, MutationFixture.AdminEmail), OperatorRole.Full)
            assert.ok((await id.ListOperators()).some(o => o.role === OperatorRole.Full && !o.disabled))
        })
    })

    it('unknown email throws OperatorNotFoundError on every mutation', async () =>
    {
        await MutationFixture.WithIdentity(async id =>
        {
            const u = MutationFixture.UnknownEmail
            await assert.rejects(id.SetOperatorRole(u, OperatorRole.Full, MutationFixture.ActorSentinel), OperatorNotFoundError)
            await assert.rejects(id.ResetOperatorPassword(u), OperatorNotFoundError)
            await assert.rejects(id.SetOperatorDisabled(u, true, MutationFixture.ActorSentinel), OperatorNotFoundError)
            await assert.rejects(id.RevokeOperatorSessions(u), OperatorNotFoundError)
        })
    })
})
