import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { ServerIdentityPack } from '@pragmatic-tech-ai/pragmatic-identity-store'
import { Realm, RealmKind, DelegationDepth, AuthMethod, Credential, PresentedSecret, AuthenticatedResult, Grant, Role, ResourceRef, ResourceKind, type IdentityStoreSet } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlAuditStore, SqlIdpDirectoryStore, SqlLocalAccountStore, SqlRoleGrantStore, SqlSecretKeyRing, SqlSecretStore, SqlServiceTokenStore, SqlSessionStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { MasterKeyError } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

export { MasterKeyError }

/** Where operator sessions end: the console's session store (every session of a subject at once). */
export interface IOperatorSessionEnder
{
    RevokeSubject(subject: string): Promise<number>
}

/** Operator authority: Full may mutate (Owner grant on the control-plane realm); ReadOnly may only observe (Viewer grant, or no Owner grant). */
export enum OperatorRole
{
    Full,
    ReadOnly
}

/** Public roster entry: email, role and disabled flag; never ids, secret refs, or grants. */
export type OperatorSummary = { email: string; role: OperatorRole; disabled: boolean }

export type OperatorPrincipal = { email: string; principalId: string; role: OperatorRole }

/**
 * The platform admin console's operator accounts (the break-glass local sign-in). Sessions are not kept here: the console's
 * session store issues them; this identity checks passwords, answers who a session's subject is now (its live role, or
 * null once the account is gone or disabled) and ends a subject's sessions when its credential or access changes.
 */
export interface IOperatorIdentity
{
    /** The operator when the password is right (and the account enabled), else null. Never throws for a wrong password. */
    Verify(email: string, password: string): Promise<OperatorPrincipal | null>
    /** The operator as of now (email, current role), or null when the principal is unknown or its account disabled. */
    PrincipalOf(principalId: string): Promise<OperatorPrincipal | null>
    CreateOperator(email: string, password: string, role: OperatorRole): Promise<void>
    ListOperators(): Promise<readonly OperatorSummary[]>
    SetOperatorRole(email: string, role: OperatorRole, actorPrincipalId: string): Promise<void>
    ResetOperatorPassword(email: string): Promise<string>
    /** Verifies the current password and sets the new one; false (nothing changed) when the current one is wrong. The
     *  caller rotates its sessions (the session store's Rotate ends every other session of the operator). */
    ChangeOwnPassword(principalId: string, currentPassword: string, newPassword: string): Promise<boolean>
    SetOperatorDisabled(email: string, disabled: boolean, actorPrincipalId: string): Promise<void>
    RevokeOperatorSessions(email: string): Promise<void>
}

/**
 * `session`: the console's database (the SQL identity stores; their secrets sealed under the master key in
 * `secrets_sealed`, scope `control-plane`). `sessions`: where operator sessions end (the console's session store).
 */
export type OperatorComposeOptions = { session: ISqlSession; masterKeyFile: string; operatorEmail: string; initialPassword?: string; sessions: IOperatorSessionEnder }

export class OperatorBootstrapError extends Error
{
    private static readonly ErrorName = 'OperatorBootstrapError'
    private static readonly DefaultMessage = 'Fresh control plane has no operator: set PRAGMATIC_ADMIN_OPERATOR_PASSWORD to bootstrap one'

    public constructor(message: string = OperatorBootstrapError.DefaultMessage)
    {
        super(message)
        this.name = OperatorBootstrapError.ErrorName
    }
}

export class OperatorExistsError extends Error
{
    private static readonly ErrorName = 'OperatorExistsError'
    private static readonly DefaultMessage = 'An operator with that email already exists'

    public constructor(message: string = OperatorExistsError.DefaultMessage)
    {
        super(message)
        this.name = OperatorExistsError.ErrorName
    }
}

export class OperatorNotFoundError extends Error
{
    private static readonly ErrorName = 'OperatorNotFoundError'
    private static readonly DefaultMessage = 'No operator with that email exists'

    public constructor(message: string = OperatorNotFoundError.DefaultMessage)
    {
        super(message)
        this.name = OperatorNotFoundError.ErrorName
    }
}

export class OperatorSelfLockoutError extends Error
{
    private static readonly ErrorName = 'OperatorSelfLockoutError'
    private static readonly DefaultMessage = 'An operator cannot lock themselves out'

    public constructor(message: string = OperatorSelfLockoutError.DefaultMessage)
    {
        super(message)
        this.name = OperatorSelfLockoutError.ErrorName
    }
}

export class LastOperatorError extends Error
{
    private static readonly ErrorName = 'LastOperatorError'
    private static readonly DefaultMessage = 'The last full-access operator cannot be demoted or disabled'

    public constructor(message: string = LastOperatorError.DefaultMessage)
    {
        super(message)
        this.name = LastOperatorError.ErrorName
    }
}

export class OperatorProtectedError extends Error
{
    private static readonly ErrorName = 'OperatorProtectedError'
    private static readonly DefaultMessage = 'The bootstrap administrator account is protected from this change'

    public constructor(message: string = OperatorProtectedError.DefaultMessage)
    {
        super(message)
        this.name = OperatorProtectedError.ErrorName
    }
}

export class OperatorIdentity implements IOperatorIdentity
{
    private static readonly OperatorRealmId = 'control-plane'
    private static readonly OperatorRealmDisplay = 'SP-ADMIN Control Plane'
    private static readonly AdminPrincipalId = 'admin'
    private static readonly AdminPasswordRef = 'control-plane-admin-pw'
    private static readonly EmailClaim = 'email'
    private static readonly MasterKeyBytes = 32
    private static readonly GeneratedPasswordBytes = 24
    private static readonly PasswordEncoding = 'base64url'
    private static readonly KeyFileMode = 0o600
    private static readonly SecretDirMode = 0o700
    private static readonly BadMasterKeyMessage = 'Master key file must contain exactly 32 bytes'
    private static readonly MissingMasterKeyMessage = 'The master key file is missing, but the database already holds operator accounts sealed under a master key: restore the key file (a new key would make every sealed secret unreadable)'
    /** The key id the identity secrets are sealed under (the master key; a rotation adds the next id). */
    public static readonly SecretKeyId = 'master'
    /** The secret-store scope of the operator realm's secrets. */
    public static readonly SecretScope = OperatorIdentity.OperatorRealmId
    /** The bootstrap administrator's principal and password reference (the importer copies them). */
    public static readonly BootstrapPrincipalId = OperatorIdentity.AdminPrincipalId
    public static readonly BootstrapPasswordRef = OperatorIdentity.AdminPasswordRef

    private constructor(
        private readonly pack: ServerIdentityPack,
        private readonly realm: Realm,
        private readonly operatorEmail: string,
        private readonly sessions: IOperatorSessionEnder)
    {
    }

    /** The operator realm (the importer copies its records). */
    public static Realm(): Realm
    {
        return new Realm(OperatorIdentity.OperatorRealmId, RealmKind.SelfHosted, OperatorIdentity.OperatorRealmDisplay)
    }

    /** The operator accounts table (opened without the master key: to ask whether operators exist). */
    public static AccountStore(session: ISqlSession): Promise<SqlLocalAccountStore>
    {
        return SqlLocalAccountStore.Open(session)
    }

    /** The SQL identity stores of the operator realm, over the console's database (secrets sealed under `masterKey`). */
    public static async OpenStores(session: ISqlSession, masterKey: Buffer): Promise<IdentityStoreSet>
    {
        return {
            Secrets: await SqlSecretStore.Open(session, SqlSecretKeyRing.Single(OperatorIdentity.SecretKeyId, masterKey), OperatorIdentity.SecretScope),
            Accounts: await SqlLocalAccountStore.Open(session),
            Tokens: await SqlServiceTokenStore.Open(session),
            Sessions: await SqlSessionStore.Open(session),
            Grants: await SqlRoleGrantStore.Open(session),
            Audit: await SqlAuditStore.Open(session),
            IdpDirectory: await SqlIdpDirectoryStore.Open(session),
        }
    }

    public static async Compose(options: OperatorComposeOptions): Promise<OperatorIdentity>
    {
        mkdirSync(dirname(options.masterKeyFile), { recursive: true, mode: OperatorIdentity.SecretDirMode })
        const realm = OperatorIdentity.Realm()
        if (!existsSync(options.masterKeyFile) && (await (await OperatorIdentity.AccountStore(options.session)).ListAccounts(realm)).length > 0)
        {
            throw new MasterKeyError(OperatorIdentity.MissingMasterKeyMessage)
        }
        const key = OperatorIdentity.LoadOrCreateKey(options.masterKeyFile)
        const stores = await OperatorIdentity.OpenStores(options.session, key)
        const pack = ServerIdentityPack.OpenWith(stores, { DelegationDepth: DelegationDepth.FullAuthz })
        const existing = await pack.Directory.Lookup(OperatorIdentity.AdminPrincipalId, realm)
        if (existing === null)
        {
            if (options.initialPassword === undefined)
            {
                throw new OperatorBootstrapError()
            }
            await pack.Secrets.Put(OperatorIdentity.AdminPasswordRef, options.initialPassword)
        }
        // Idempotent: for an existing account this only re-ensures the Owner grant (no password change).
        await OperatorIdentity.SeedOwnerAsync(pack, realm, options.operatorEmail)
        return new OperatorIdentity(pack, realm, options.operatorEmail, options.sessions)
    }

    /**
     * First-run seed of the bootstrap operator: registers the account from the stored password reference when it does
     * not exist yet (no password stored: nothing is registered), then ensures its Owner grant on the realm (Register and
     * Grants.Save are not atomic: a crash between them is repaired here). The password is never inlined or logged.
     */
    private static async SeedOwnerAsync(pack: ServerIdentityPack, realm: Realm, email: string): Promise<void>
    {
        const O = OperatorIdentity
        if (await pack.Directory.Lookup(O.AdminPrincipalId, realm) === null)
        {
            const password = await pack.Secrets.Get(O.AdminPasswordRef)
            if (password === null)
            {
                return
            }
            const presented = new PresentedSecret(password)
            try
            {
                await pack.Registrar.Register(realm, email, O.AdminPrincipalId, presented)
            }
            finally
            {
                presented.Clear()
            }
        }
        const grants = await pack.Grants.GrantsFor(O.AdminPrincipalId, realm)
        if (!grants.some(g => g.Role === Role.Owner && g.Resource.Kind === ResourceKind.Realm && g.Resource.RealmId === realm.Id))
        {
            await pack.Grants.Save(new Grant(O.AdminPrincipalId, Role.Owner, new ResourceRef(ResourceKind.Realm, realm.Id, [])))
        }
    }

    public async Verify(email: string, password: string): Promise<OperatorPrincipal | null>
    {
        const auth = this.pack.AuthenticatorFor(AuthMethod.Local)
        if (auth === undefined)
        {
            return null
        }
        const presented = new PresentedSecret(password)
        try
        {
            const result = await auth.Authenticate(new Credential(AuthMethod.Local, email), presented, this.realm)
            if (!(result instanceof AuthenticatedResult))
            {
                return null
            }
            return await this.PrincipalOf(result.Principal.Id)
        }
        finally
        {
            presented.Clear()
        }
    }

    public async PrincipalOf(principalId: string): Promise<OperatorPrincipal | null>
    {
        const principal = await this.pack.Directory.Lookup(principalId, this.realm)
        if (principal === null)
        {
            return null
        }
        const account = await this.pack.Accounts.FindByPrincipalId(this.realm, principalId)
        if (account !== null && account.Disabled !== false)
        {
            return null
        }
        return { email: await this.EmailOf(principal.Id, principal.Claim(OperatorIdentity.EmailClaim)), principalId: principal.Id, role: await this.RoleFor(principal.Id) }
    }

    /** Creates an authenticatable operator account and grants it the Owner (Full) or Viewer (ReadOnly) role on the control-plane realm. */
    public async CreateOperator(email: string, password: string, role: OperatorRole): Promise<void>
    {
        if ((await this.pack.Accounts.FindByEmail(this.realm, email)) !== null)
        {
            throw new OperatorExistsError()
        }
        const principalId = randomUUID()
        const presented = new PresentedSecret(password)
        try
        {
            await this.pack.Registrar.Register(this.realm, email, principalId, presented)
        }
        finally
        {
            presented.Clear()
        }
        const grantRole = role === OperatorRole.Full ? Role.Owner : Role.Viewer
        await this.pack.Grants.Save(new Grant(principalId, grantRole, new ResourceRef(ResourceKind.Realm, this.realm.Id, [])))
    }

    /** Operator roster: email, role and disabled flag; includes disabled accounts. The bootstrap admin appears exactly once, under the configured operator email. */
    public async ListOperators(): Promise<readonly OperatorSummary[]>
    {
        const accounts = await this.pack.Accounts.ListAccounts(this.realm)
        const summaries: OperatorSummary[] = []
        let sawAdmin = false
        for (const account of accounts)
        {
            const isAdmin = account.PrincipalId === OperatorIdentity.AdminPrincipalId
            sawAdmin = sawAdmin || isAdmin
            summaries.push({ email: isAdmin ? this.operatorEmail : account.Email, role: await this.RoleFor(account.PrincipalId), disabled: account.Disabled !== false })
        }
        if (!sawAdmin)
        {
            summaries.unshift({ email: this.operatorEmail, role: OperatorRole.Full, disabled: false })
        }
        const seen = new Set<string>()
        return summaries.filter(s =>
        {
            if (seen.has(s.email))
            {
                return false
            }
            seen.add(s.email)
            return true
        })
    }

    /** Changes an operator's role. Save is append-only, so the old role grant is revoked first. Guards run before any state change. */
    public async SetOperatorRole(email: string, role: OperatorRole, actorPrincipalId: string): Promise<void>
    {
        const principalId = await this.ResolvePrincipal(email)
        this.RejectIfProtected(principalId)
        if ((await this.RoleFor(principalId)) === role)
        {
            return
        }
        if (role === OperatorRole.ReadOnly)
        {
            if (principalId === actorPrincipalId)
            {
                throw new OperatorSelfLockoutError()
            }
            await this.RejectIfLastFull(principalId)
        }
        const grants = await this.pack.Grants.GrantsFor(principalId, this.realm)
        for (const g of grants)
        {
            const onRoot = g.Resource.Kind === ResourceKind.Realm && g.Resource.RealmId === this.realm.Id
            if (onRoot && (g.Role === Role.Owner || g.Role === Role.Viewer))
            {
                await this.pack.Grants.Revoke(g)
            }
        }
        const grantRole = role === OperatorRole.Full ? Role.Owner : Role.Viewer
        await this.pack.Grants.Save(new Grant(principalId, grantRole, new ResourceRef(ResourceKind.Realm, this.realm.Id, [])))
    }

    /**
     * Rotates the operator's password to a generated one and returns it; this return value is the only place it is exposed.
     * Every live session of the operator ends with the old password, the caller's own included when they reset themselves.
     */
    public async ResetOperatorPassword(email: string): Promise<string>
    {
        const principalId = await this.ResolvePrincipal(email)
        const password = randomBytes(OperatorIdentity.GeneratedPasswordBytes).toString(OperatorIdentity.PasswordEncoding)
        const presented = new PresentedSecret(password)
        try
        {
            await this.pack.Registrar.RotatePasswordIfChanged(this.realm, principalId, presented)
        }
        finally
        {
            presented.Clear()
        }
        await this.sessions.RevokeSubject(principalId)
        return password
    }

    /**
     * Self-service change: verifies the CURRENT password of the signed-in operator (`principalId`, against the email its
     * account signs in with) and sets the new one. False when the current password does not verify for that principal;
     * nothing changes then. The caller ends the operator's other sessions (and gets its own fresh one) through the session
     * store's Rotate. Neither password is ever logged or kept.
     */
    public async ChangeOwnPassword(principalId: string, currentPassword: string, newPassword: string): Promise<boolean>
    {
        const auth = this.pack.AuthenticatorFor(AuthMethod.Local)
        const account = await this.pack.Accounts.FindByPrincipalId(this.realm, principalId)
        if (auth === undefined || account === null)
        {
            return false
        }
        const current = new PresentedSecret(currentPassword)
        let verified = false
        try
        {
            const result = await auth.Authenticate(new Credential(AuthMethod.Local, account.Email), current, this.realm)
            verified = result instanceof AuthenticatedResult && result.Principal.Id === principalId
        }
        finally
        {
            current.Clear()
        }
        if (!verified)
        {
            return false
        }
        const next = new PresentedSecret(newPassword)
        try
        {
            await this.pack.Registrar.RotatePasswordIfChanged(this.realm, principalId, next)
        }
        finally
        {
            next.Clear()
        }
        return true
    }

    /** Disables or re-enables an operator. Disabling also drops the operator's live sessions. Guards run before any state change. */
    public async SetOperatorDisabled(email: string, disabled: boolean, actorPrincipalId: string): Promise<void>
    {
        const principalId = await this.ResolvePrincipal(email)
        this.RejectIfProtected(principalId)
        if (disabled)
        {
            if (principalId === actorPrincipalId)
            {
                throw new OperatorSelfLockoutError()
            }
            await this.RejectIfLastFull(principalId)
            await this.pack.Accounts.Disable(this.realm, principalId)
            await this.sessions.RevokeSubject(principalId)
        }
        else
        {
            await this.pack.Accounts.Enable(this.realm, principalId)
        }
    }

    /** Drops every live session of the operator, forcing a fresh login. */
    public async RevokeOperatorSessions(email: string): Promise<void>
    {
        const principalId = await this.ResolvePrincipal(email)
        await this.sessions.RevokeSubject(principalId)
    }

    /**
     * The email an operator signs in with: the configured one for the bootstrap admin, else the principal's email claim,
     * else its local account's email (an invited operator carries no claim), and only as a last resort the principal id.
     */
    private async EmailOf(principalId: string, claim: string | undefined): Promise<string>
    {
        if (principalId === OperatorIdentity.AdminPrincipalId)
        {
            return this.operatorEmail
        }
        if (claim !== undefined)
        {
            return claim
        }
        return (await this.pack.Accounts.FindByPrincipalId(this.realm, principalId))?.Email ?? principalId
    }

    private async ResolvePrincipal(email: string): Promise<string>
    {
        const account = await this.pack.Accounts.FindByEmail(this.realm, email)
        if (account === null)
        {
            throw new OperatorNotFoundError()
        }
        return account.PrincipalId
    }

    private RejectIfProtected(principalId: string): void
    {
        if (principalId === OperatorIdentity.AdminPrincipalId)
        {
            throw new OperatorProtectedError()
        }
    }

    /** Blocks removing Full access from the only active Full operator. */
    private async RejectIfLastFull(principalId: string): Promise<void>
    {
        if ((await this.RoleFor(principalId)) !== OperatorRole.Full)
        {
            return
        }
        const accounts = await this.pack.Accounts.ListAccounts(this.realm)
        let otherFull = 0
        for (const account of accounts)
        {
            if (account.Disabled === false && account.PrincipalId !== principalId && (await this.RoleFor(account.PrincipalId)) === OperatorRole.Full)
            {
                otherFull++
            }
        }
        if (otherFull === 0)
        {
            throw new LastOperatorError()
        }
    }

    /** Deny-by-default: Full only when an Owner grant on this realm exists; anything else is ReadOnly. */
    private async RoleFor(principalId: string): Promise<OperatorRole>
    {
        const grants = await this.pack.Grants.GrantsFor(principalId, this.realm)
        const isOwner = grants.some(g => g.Role === Role.Owner && g.Resource.Kind === ResourceKind.Realm && g.Resource.RealmId === this.realm.Id)
        return isOwner ? OperatorRole.Full : OperatorRole.ReadOnly
    }

    private static LoadOrCreateKey(file: string): Buffer
    {
        if (existsSync(file))
        {
            const key = readFileSync(file)
            if (key.length !== OperatorIdentity.MasterKeyBytes)
            {
                throw new MasterKeyError(OperatorIdentity.BadMasterKeyMessage)
            }
            return key
        }
        const key = randomBytes(OperatorIdentity.MasterKeyBytes)
        writeFileSync(file, key, { mode: OperatorIdentity.KeyFileMode })
        return key
    }
}
