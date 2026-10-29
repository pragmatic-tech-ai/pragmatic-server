import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { FileIdentityStores, ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import { Tenant, TenantKind, DelegationDepth, AuthMethod, Credential, PresentedSecret, AuthenticatedResult, Grant, Role, ResourceRef, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import { ServerBootstrap } from '../../src/identity/server-bootstrap.js'

export type OperatorSession = { token: string; expiresAt: Date }

/** Operator authority: Full may mutate (Owner grant on the control-plane tenant); ReadOnly may only observe (Viewer grant, or no Owner grant). */
export enum OperatorRole
{
    Full,
    ReadOnly
}

/** Public roster entry: email, role and disabled flag; never ids, secret refs, or grants. */
export type OperatorSummary = { email: string; role: OperatorRole; disabled: boolean }

export type OperatorPrincipal = { email: string; principalId: string; role: OperatorRole }

export interface IOperatorIdentity
{
    Authenticate(email: string, password: string): Promise<OperatorSession | null>
    ValidateToken(token: string): Promise<OperatorPrincipal | null>
    Revoke(token: string): Promise<void>
    CreateOperator(email: string, password: string, role: OperatorRole): Promise<void>
    ListOperators(): Promise<readonly OperatorSummary[]>
    SetOperatorRole(email: string, role: OperatorRole, actorPrincipalId: string): Promise<void>
    ResetOperatorPassword(email: string): Promise<string>
    SetOperatorDisabled(email: string, disabled: boolean, actorPrincipalId: string): Promise<void>
    RevokeOperatorSessions(email: string): Promise<void>
}

export type OperatorComposeOptions = { identityRoot: string; masterKeyFile: string; operatorEmail: string; initialPassword?: string }

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

export class MasterKeyError extends Error
{
    private static readonly ErrorName = 'MasterKeyError'

    public constructor(message: string)
    {
        super(message)
        this.name = MasterKeyError.ErrorName
    }
}

export class OperatorIdentity implements IOperatorIdentity
{
    private static readonly OperatorTenantId = 'control-plane'
    private static readonly OperatorTenantDisplay = 'SP-ADMIN Control Plane'
    private static readonly AdminPrincipalId = 'admin'
    private static readonly AdminPasswordRef = 'control-plane-admin-pw'
    private static readonly EmailClaim = 'email'
    private static readonly MasterKeyBytes = 32
    private static readonly GeneratedPasswordBytes = 24
    private static readonly PasswordEncoding = 'base64url'
    private static readonly KeyFileMode = 0o600
    private static readonly SecretDirMode = 0o700
    private static readonly BadMasterKeyMessage = 'Master key file must contain exactly 32 bytes'

    private constructor(
        private readonly pack: ServerIdentityPack,
        private readonly tenant: Tenant,
        private readonly operatorEmail: string)
    {
    }

    public static async Compose(options: OperatorComposeOptions): Promise<OperatorIdentity>
    {
        mkdirSync(dirname(options.masterKeyFile), { recursive: true, mode: OperatorIdentity.SecretDirMode })
        mkdirSync(options.identityRoot, { recursive: true, mode: OperatorIdentity.SecretDirMode })
        const key = OperatorIdentity.LoadOrCreateKey(options.masterKeyFile)
        const tenant = new Tenant(OperatorIdentity.OperatorTenantId, TenantKind.SelfHosted, OperatorIdentity.OperatorTenantDisplay)
        const stores = await FileIdentityStores.Open(new NodeFsStorage(options.identityRoot), key)
        const pack = ServerIdentityPack.OpenWith(stores, { DelegationDepth: DelegationDepth.FullAuthz })
        const existing = await pack.Directory.Lookup(OperatorIdentity.AdminPrincipalId, tenant)
        if (existing === null)
        {
            if (options.initialPassword === undefined)
            {
                throw new OperatorBootstrapError()
            }
            await pack.Secrets.Put(OperatorIdentity.AdminPasswordRef, options.initialPassword)
        }
        // Idempotent: for an existing account this only re-ensures the Owner grant (no password change).
        await ServerBootstrap.SeedAsync(pack, tenant, {
            adminEmail: options.operatorEmail,
            adminPrincipalId: OperatorIdentity.AdminPrincipalId,
            adminPasswordRef: OperatorIdentity.AdminPasswordRef,
            ownerGrant: true
        })
        return new OperatorIdentity(pack, tenant, options.operatorEmail)
    }

    public async Authenticate(email: string, password: string): Promise<OperatorSession | null>
    {
        const auth = this.pack.AuthenticatorFor(AuthMethod.Local)
        if (auth === undefined)
        {
            return null
        }
        const presented = new PresentedSecret(password)
        try
        {
            const result = await auth.Authenticate(new Credential(AuthMethod.Local, email), presented, this.tenant)
            if (!(result instanceof AuthenticatedResult))
            {
                return null
            }
            const session = await this.pack.Sessions.Issue(result.Principal)
            return { token: session.Id, expiresAt: session.ExpiresAt }
        }
        finally
        {
            presented.Clear()
        }
    }

    public async ValidateToken(token: string): Promise<OperatorPrincipal | null>
    {
        const session = await this.pack.Sessions.Validate(token)
        if (session === null)
        {
            return null
        }
        const principal = await this.pack.Directory.Lookup(session.PrincipalId, this.tenant)
        if (principal === null)
        {
            return null
        }
        const email = principal.Id === OperatorIdentity.AdminPrincipalId ? this.operatorEmail : (principal.Claim(OperatorIdentity.EmailClaim) ?? principal.Id)
        return { email, principalId: principal.Id, role: await this.RoleFor(principal.Id) }
    }

    /** Creates an authenticatable operator account and grants it the Owner (Full) or Viewer (ReadOnly) role on the control-plane tenant. */
    public async CreateOperator(email: string, password: string, role: OperatorRole): Promise<void>
    {
        if ((await this.pack.Accounts.FindByEmail(this.tenant, email)) !== null)
        {
            throw new OperatorExistsError()
        }
        const principalId = randomUUID()
        const presented = new PresentedSecret(password)
        try
        {
            await this.pack.Registrar.Register(this.tenant, email, principalId, presented)
        }
        finally
        {
            presented.Clear()
        }
        const grantRole = role === OperatorRole.Full ? Role.Owner : Role.Viewer
        await this.pack.Grants.Save(new Grant(principalId, grantRole, new ResourceRef(ResourceKind.Tenant, this.tenant.Id, [])))
    }

    /** Operator roster: email, role and disabled flag; includes disabled accounts. The bootstrap admin appears exactly once, under the configured operator email. */
    public async ListOperators(): Promise<readonly OperatorSummary[]>
    {
        const accounts = await this.pack.Accounts.ListAccounts(this.tenant)
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
        const grants = await this.pack.Grants.GrantsFor(principalId, this.tenant)
        for (const g of grants)
        {
            const onRoot = g.Resource.Kind === ResourceKind.Tenant && g.Resource.TenantId === this.tenant.Id
            if (onRoot && (g.Role === Role.Owner || g.Role === Role.Viewer))
            {
                await this.pack.Grants.Revoke(g)
            }
        }
        const grantRole = role === OperatorRole.Full ? Role.Owner : Role.Viewer
        await this.pack.Grants.Save(new Grant(principalId, grantRole, new ResourceRef(ResourceKind.Tenant, this.tenant.Id, [])))
    }

    /** Rotates the operator's password to a generated one and returns it; this return value is the only place it is exposed. */
    public async ResetOperatorPassword(email: string): Promise<string>
    {
        const principalId = await this.ResolvePrincipal(email)
        const password = randomBytes(OperatorIdentity.GeneratedPasswordBytes).toString(OperatorIdentity.PasswordEncoding)
        const presented = new PresentedSecret(password)
        try
        {
            await this.pack.Registrar.RotatePasswordIfChanged(this.tenant, principalId, presented)
        }
        finally
        {
            presented.Clear()
        }
        return password
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
            await this.pack.Accounts.Disable(this.tenant, principalId)
            await this.pack.Sessions.RevokeAllFor(this.tenant, principalId)
        }
        else
        {
            await this.pack.Accounts.Enable(this.tenant, principalId)
        }
    }

    /** Drops every live session of the operator, forcing a fresh login. */
    public async RevokeOperatorSessions(email: string): Promise<void>
    {
        const principalId = await this.ResolvePrincipal(email)
        await this.pack.Sessions.RevokeAllFor(this.tenant, principalId)
    }

    private async ResolvePrincipal(email: string): Promise<string>
    {
        const account = await this.pack.Accounts.FindByEmail(this.tenant, email)
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
        const accounts = await this.pack.Accounts.ListAccounts(this.tenant)
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

    /** Deny-by-default: Full only when an Owner grant on this tenant exists; anything else is ReadOnly. */
    private async RoleFor(principalId: string): Promise<OperatorRole>
    {
        const grants = await this.pack.Grants.GrantsFor(principalId, this.tenant)
        const isOwner = grants.some(g => g.Role === Role.Owner && g.Resource.Kind === ResourceKind.Tenant && g.Resource.TenantId === this.tenant.Id)
        return isOwner ? OperatorRole.Full : OperatorRole.ReadOnly
    }

    public async Revoke(token: string): Promise<void>
    {
        const session = await this.pack.Sessions.Validate(token)
        if (session !== null)
        {
            await this.pack.Sessions.Revoke(session.Id)
        }
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
