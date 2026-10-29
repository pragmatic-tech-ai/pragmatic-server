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

/** Public roster entry: email and role only; never ids, secret refs, or grants. */
export type OperatorSummary = { email: string; role: OperatorRole }

export type OperatorPrincipal = { email: string; principalId: string; role: OperatorRole }

export interface IOperatorIdentity
{
    Authenticate(email: string, password: string): Promise<OperatorSession | null>
    ValidateToken(token: string): Promise<OperatorPrincipal | null>
    Revoke(token: string): Promise<void>
    CreateOperator(email: string, password: string, role: OperatorRole): Promise<void>
    ListOperators(): Promise<readonly OperatorSummary[]>
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

    /** Active operator roster (email + role only). The bootstrap admin appears exactly once, under the configured operator email. */
    public async ListOperators(): Promise<readonly OperatorSummary[]>
    {
        const accounts = await this.pack.Accounts.ListAccounts(this.tenant)
        const summaries: OperatorSummary[] = []
        let sawAdmin = false
        for (const account of accounts)
        {
            if (account.Disabled !== false)
            {
                continue
            }
            const isAdmin = account.PrincipalId === OperatorIdentity.AdminPrincipalId
            sawAdmin = sawAdmin || isAdmin
            summaries.push({ email: isAdmin ? this.operatorEmail : account.Email, role: await this.RoleFor(account.PrincipalId) })
        }
        if (!sawAdmin)
        {
            summaries.unshift({ email: this.operatorEmail, role: OperatorRole.Full })
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
