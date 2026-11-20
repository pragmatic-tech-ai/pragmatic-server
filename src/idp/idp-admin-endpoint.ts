import { createHash, timingSafeEqual } from 'node:crypto';
import { ComponentDescriptorCodec } from '@pragmatic-tech-ai/pragmatic-component';
import { ApplicationDeclaration, InvalidRealmRoleError, RealmRole, RoleMapping, RoleMember } from '@pragmatic-tech-ai/pragmatic-identity';
import type { IApplicationCatalogue } from '@pragmatic-tech-ai/pragmatic-identity';
import { RoleMappingError, type RoleMappingService } from '@pragmatic-tech-ai/pragmatic-identity-realm';
import { ReservedRealmError, type IdpRealmSet } from './idp-realm-set.js';
import type { SqlIdpClientStore } from './sql-idp-client-store.js';
import type { SqlRefreshTokenStore } from './sql-refresh-token-store.js';
import type { SqlSsoSessionStore } from './sql-sso-session-store.js';

/** Status + JSON body produced by the admin endpoint. Never carries secrets. */
export class AdminResult
{
    public constructor(public readonly Status: number, public readonly Body: unknown)
    {
    }
}

/** What the admin API reaches: the realms and the stores its operations write. */
export class IdpAdminStores
{
    public constructor(
        public readonly Realms: IdpRealmSet,
        public readonly Clients: SqlIdpClientStore,
        public readonly Sso: SqlSsoSessionStore,
        public readonly RefreshTokens: SqlRefreshTokenStore,
        public readonly Roles: RoleMappingService,
        public readonly Applications: IApplicationCatalogue)
    {
        Object.freeze(this);
    }
}

/**
 * The authenticated provisioning API of the realm sign-in service, under `/_admin/realms/<realm>`: ensure a realm,
 * seed an account, reset its password (ends its SSO sessions and refresh tokens), register and remove clients, the
 * role mappings (the assignable roles, list, add, remove; used by the tenant admin console), the applications whose
 * roles the realm offers (a component descriptor each), and the realm's secrets (the `realm` store a configuration's
 * secret references name). The bearer token is verified before any routing or body inspection; nothing is logged and
 * no password, client secret, realm secret or admin token ever appears in a result.
 */
export class IdpAdminEndpoint
{
    private static readonly BearerPrefix = 'Bearer ';
    private static readonly HashAlgorithm = 'sha256';
    private static readonly RealmsSegment = 'realms';
    private static readonly AccountsSegment = 'accounts';
    private static readonly ClientsSegment = 'clients';
    private static readonly PasswordSegment = 'password';
    private static readonly DisableSegment = 'disable';
    private static readonly EnableSegment = 'enable';
    private static readonly DisabledField = 'disabled';
    private static readonly HttpsProtocol = 'https:';
    private static readonly HttpProtocol = 'http:';
    private static readonly LoopbackHosts: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);
    private static readonly RolesSegment = 'roles';
    private static readonly MappingsSegment = 'role-mappings';
    private static readonly ApplicationsSegment = 'applications';
    private static readonly SecretsSegment = 'secrets';
    private static readonly GetMethod = 'GET';
    private static readonly PutMethod = 'PUT';
    private static readonly PostMethod = 'POST';
    private static readonly DeleteMethod = 'DELETE';
    private static readonly RealmIndex = 1;
    private static readonly ResourceIndex = 2;
    private static readonly ItemIndex = 3;
    private static readonly ActionIndex = 4;
    private static readonly RealmPathLength = 2;
    private static readonly ResourcePathLength = 3;
    private static readonly ItemPathLength = 4;
    private static readonly ActionPathLength = 5;
    private static readonly OkStatus = 200;
    private static readonly BadRequestStatus = 400;
    private static readonly UnauthorizedStatus = 401;
    private static readonly NotFoundStatus = 404;
    private static readonly UnauthorizedCode = 'unauthorized';
    private static readonly InvalidBodyCode = 'invalid_body';
    private static readonly InvalidRealmCode = 'invalid_realm';
    private static readonly NotFoundCode = 'not_found';
    private static readonly UnknownRealmCode = 'unknown_realm';
    private static readonly UnknownAccountCode = 'unknown_account';
    private static readonly InvalidDescriptorCode = 'invalid_descriptor';
    private static readonly ErrorField = 'error';
    private static readonly RoleField = 'role';
    private static readonly MemberField = 'member';
    private static readonly KindField = 'kind';
    private static readonly SourceField = 'source';
    private static readonly ValueField = 'value';
    private static readonly DescriptionField = 'description';
    private static readonly AddedField = 'added';
    private static readonly RemovedField = 'removed';
    private static readonly TenantIdField = 'tenantId';
    private static readonly RealmIdField = 'realmId';
    private static readonly IssuerField = 'issuer';
    private static readonly SourcesField = 'sources';
    private static readonly PrincipalIdField = 'principalId';
    private static readonly ClientIdField = 'clientId';
    private static readonly DisplayNameField = 'displayName';
    private static readonly EmailField = 'email';
    private static readonly PasswordField = 'password';
    private static readonly RedirectUrisField = 'redirectUris';
    private static readonly PostLogoutRedirectUrisField = 'postLogoutRedirectUris';
    private static readonly SecretField = 'secret';
    private static readonly NameField = 'name';
    private static readonly SecretName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
    private static readonly NoSource = '';

    private readonly adminTokenDigests: readonly Buffer[];

    /** `adminTokens` is the set of currently valid admin tokens (several during a rotation); an empty set rejects everything. */
    public constructor(adminTokens: readonly string[], private readonly stores: IdpAdminStores)
    {
        this.adminTokenDigests = adminTokens.filter(t => t.length > 0).map(t => IdpAdminEndpoint.Digest(t));
    }

    public async Handle(method: string, segments: readonly string[], authorization: string | undefined, body: unknown): Promise<AdminResult>
    {
        const A = IdpAdminEndpoint;
        if (!this.VerifyToken(authorization))
        {
            return A.Fail(A.UnauthorizedStatus, A.UnauthorizedCode);
        }
        if (segments[0] !== A.RealmsSegment || segments.length < A.RealmPathLength)
        {
            return A.NotFound();
        }
        const realmId = segments[A.RealmIndex]!;
        try
        {
            if (segments.length === A.RealmPathLength)
            {
                return method === A.PutMethod ? await this.PutRealm(realmId, body) : method === A.GetMethod ? this.GetRealm(realmId) : A.NotFound();
            }
            if (this.stores.Realms.For(realmId) === undefined)
            {
                return A.Fail(A.NotFoundStatus, A.UnknownRealmCode);
            }
            return await this.RealmResource(method, realmId, segments, body);
        }
        catch (err)
        {
            if (err instanceof ReservedRealmError)
            {
                return A.Fail(A.BadRequestStatus, A.InvalidRealmCode);
            }
            if (err instanceof RoleMappingError)
            {
                return A.Fail(A.BadRequestStatus, err.Reason);
            }
            throw err;
        }
    }

    /** Whether an Authorization header carries a valid admin bearer token. Constant-time; never logs the token. */
    public IsAdminCredential(authorization: string | undefined): boolean
    {
        return this.VerifyToken(authorization);
    }

    private async RealmResource(method: string, realmId: string, segments: readonly string[], body: unknown): Promise<AdminResult>
    {
        const A = IdpAdminEndpoint;
        const resource = segments[A.ResourceIndex];
        const item = segments[A.ItemIndex];
        if (segments.length === A.ResourcePathLength)
        {
            switch (resource + method)
            {
                case A.AccountsSegment + A.PostMethod: return await this.PostAccount(realmId, body);
                case A.ClientsSegment + A.PostMethod: return await this.PostClient(realmId, body);
                case A.RolesSegment + A.GetMethod: return await this.GetRoles(realmId);
                case A.MappingsSegment + A.GetMethod: return await this.GetMappings(realmId);
                case A.MappingsSegment + A.PostMethod: return await this.AddMapping(realmId, body);
                case A.MappingsSegment + A.DeleteMethod: return await this.RemoveMapping(realmId, body);
                default: return A.NotFound();
            }
        }
        if (segments.length === A.ItemPathLength && item !== undefined)
        {
            switch (resource + method)
            {
                case A.ClientsSegment + A.DeleteMethod: return await this.DeleteClient(realmId, item);
                case A.ApplicationsSegment + A.PutMethod: return await this.PutApplication(realmId, item, body);
                case A.ApplicationsSegment + A.DeleteMethod: return await this.DeleteApplication(realmId, item);
                case A.SecretsSegment + A.PutMethod: return await this.PutSecret(realmId, item, body);
                case A.SecretsSegment + A.DeleteMethod: return await this.DeleteSecret(realmId, item);
                default: return A.NotFound();
            }
        }
        if (segments.length === A.ActionPathLength && item !== undefined && resource === A.AccountsSegment && method === A.PostMethod)
        {
            switch (segments[A.ActionIndex])
            {
                case A.PasswordSegment: return await this.PostPasswordReset(realmId, item, body);
                case A.DisableSegment: return await this.SetDisabled(realmId, item, true);
                case A.EnableSegment: return await this.SetDisabled(realmId, item, false);
                default: return A.NotFound();
            }
        }
        return A.NotFound();
    }

    private VerifyToken(authorization: string | undefined): boolean
    {
        if (typeof authorization !== 'string' || !authorization.startsWith(IdpAdminEndpoint.BearerPrefix))
        {
            return false;
        }
        const presented = authorization.slice(IdpAdminEndpoint.BearerPrefix.length);
        if (presented.length === 0)
        {
            return false;
        }
        const presentedDigest = IdpAdminEndpoint.Digest(presented);
        // Constant work: compare against EVERY member, never short-circuit, so timing does not reveal which / how many matched.
        let matched = false;
        for (const digest of this.adminTokenDigests)
        {
            const equal = timingSafeEqual(presentedDigest, digest);
            matched = matched || equal;
        }
        return matched;
    }

    private async PutRealm(realmId: string, body: unknown): Promise<AdminResult>
    {
        const A = IdpAdminEndpoint;
        const displayName = A.NonEmptyString(A.AsRecord(body)?.[A.DisplayNameField]);
        if (displayName === undefined)
        {
            return A.InvalidBody();
        }
        await this.stores.Realms.EnsureRealm(realmId, displayName);
        return new AdminResult(A.OkStatus, { [A.TenantIdField]: realmId });
    }

    private GetRealm(realmId: string): AdminResult
    {
        const A = IdpAdminEndpoint;
        const realm = this.stores.Realms.For(realmId);
        if (realm === undefined)
        {
            return A.Fail(A.NotFoundStatus, A.UnknownRealmCode);
        }
        return new AdminResult(A.OkStatus, {
            [A.RealmIdField]: realm.Id,
            [A.DisplayNameField]: realm.DisplayName,
            [A.IssuerField]: realm.Issuer,
            [A.SourcesField]: [...realm.Settings.SourceIds()],
        });
    }

    private async PostAccount(realmId: string, body: unknown): Promise<AdminResult>
    {
        const A = IdpAdminEndpoint;
        const fields = A.AsRecord(body);
        const email = A.NonEmptyString(fields?.[A.EmailField]);
        const principalId = A.NonEmptyString(fields?.[A.PrincipalIdField]);
        const displayName = A.NonEmptyString(fields?.[A.DisplayNameField]);
        const password = A.NonEmptyString(fields?.[A.PasswordField]);
        if (email === undefined || principalId === undefined || displayName === undefined || password === undefined)
        {
            return A.InvalidBody();
        }
        await this.stores.Realms.For(realmId)!.SeedAccount(email, principalId, password, displayName);
        return new AdminResult(A.OkStatus, { [A.PrincipalIdField]: principalId });
    }

    private async PostPasswordReset(realmId: string, principalId: string, body: unknown): Promise<AdminResult>
    {
        const A = IdpAdminEndpoint;
        const password = A.NonEmptyString(A.AsRecord(body)?.[A.PasswordField]);
        if (password === undefined)
        {
            return A.InvalidBody();
        }
        if (!(await this.stores.Realms.For(realmId)!.ResetPassword(principalId, password)))
        {
            return A.Fail(A.NotFoundStatus, A.UnknownAccountCode);
        }
        // An SSO cookie or refresh token issued before the reset must not re-authorize without the new password.
        await this.stores.Sso.RevokeAccount(realmId, principalId);
        await this.stores.RefreshTokens.RevokeAccount(realmId, principalId);
        return new AdminResult(A.OkStatus, { [A.PrincipalIdField]: principalId });
    }

    /** Disables or enables a realm account (local or federated); a disabled one's SSO sessions and refresh tokens end. */
    private async SetDisabled(realmId: string, accountId: string, disabled: boolean): Promise<AdminResult>
    {
        const A = IdpAdminEndpoint;
        if (!(await this.stores.Realms.For(realmId)!.SetDisabled(accountId, disabled)))
        {
            return A.Fail(A.NotFoundStatus, A.UnknownAccountCode);
        }
        if (disabled)
        {
            await this.stores.Sso.RevokeAccount(realmId, accountId);
            await this.stores.RefreshTokens.RevokeAccount(realmId, accountId);
        }
        return new AdminResult(A.OkStatus, { [A.PrincipalIdField]: accountId, [A.DisabledField]: disabled });
    }

    private async PostClient(realmId: string, body: unknown): Promise<AdminResult>
    {
        const A = IdpAdminEndpoint;
        const fields = A.AsRecord(body);
        const clientId = A.NonEmptyString(fields?.[A.ClientIdField]);
        const secret = A.NonEmptyString(fields?.[A.SecretField]);
        const redirectUris = A.AbsoluteUrlList(fields?.[A.RedirectUrisField], false);
        const postLogout = fields?.[A.PostLogoutRedirectUrisField] === undefined ? [] : A.AbsoluteUrlList(fields[A.PostLogoutRedirectUrisField], true);
        if (clientId === undefined || secret === undefined || redirectUris === undefined || postLogout === undefined)
        {
            return A.InvalidBody();
        }
        if (await this.stores.Clients.Register(realmId, clientId, redirectUris, secret, postLogout))
        {
            // A rotated secret: what was issued under the old one ends.
            await this.stores.RefreshTokens.RevokeClient(realmId, clientId);
        }
        return new AdminResult(A.OkStatus, { [A.ClientIdField]: clientId });
    }

    /** Idempotent teardown: 200 whether or not the client still exists; its refresh tokens end with it. */
    private async DeleteClient(realmId: string, clientId: string): Promise<AdminResult>
    {
        await this.stores.Clients.Remove(realmId, clientId);
        await this.stores.RefreshTokens.RevokeClient(realmId, clientId);
        return new AdminResult(IdpAdminEndpoint.OkStatus, { [IdpAdminEndpoint.ClientIdField]: clientId });
    }

    private async GetRoles(realmId: string): Promise<AdminResult>
    {
        const A = IdpAdminEndpoint;
        const roles = await this.stores.Roles.AssignableRoles(realmId);
        return new AdminResult(A.OkStatus, roles.map(role => ({ [A.RoleField]: role.Role.ToString(), [A.DescriptionField]: role.Description })));
    }

    private async GetMappings(realmId: string): Promise<AdminResult>
    {
        const mappings = await this.stores.Roles.List(realmId);
        return new AdminResult(IdpAdminEndpoint.OkStatus, mappings.map(mapping => IdpAdminEndpoint.MappingJson(mapping)));
    }

    private async AddMapping(realmId: string, body: unknown): Promise<AdminResult>
    {
        const mapping = IdpAdminEndpoint.MappingOf(body);
        if (mapping === undefined)
        {
            return IdpAdminEndpoint.InvalidBody();
        }
        return new AdminResult(IdpAdminEndpoint.OkStatus, { [IdpAdminEndpoint.AddedField]: await this.stores.Roles.Add(realmId, mapping) });
    }

    private async RemoveMapping(realmId: string, body: unknown): Promise<AdminResult>
    {
        const mapping = IdpAdminEndpoint.MappingOf(body);
        if (mapping === undefined)
        {
            return IdpAdminEndpoint.InvalidBody();
        }
        return new AdminResult(IdpAdminEndpoint.OkStatus, { [IdpAdminEndpoint.RemovedField]: await this.stores.Roles.Remove(realmId, mapping) });
    }

    /** Declares an application of the realm from its component descriptor (the name in the path must be its name). */
    private async PutApplication(realmId: string, name: string, body: unknown): Promise<AdminResult>
    {
        const A = IdpAdminEndpoint;
        let declaration: ApplicationDeclaration;
        try
        {
            declaration = ApplicationDeclaration.FromDescriptor(ComponentDescriptorCodec.Parse(JSON.stringify(body)));
        }
        catch
        {
            return A.Fail(A.BadRequestStatus, A.InvalidDescriptorCode);
        }
        if (declaration.Name !== name || !RealmRole.IsApplicationName(name))
        {
            return A.Fail(A.BadRequestStatus, A.InvalidDescriptorCode);
        }
        await this.stores.Applications.Declare(realmId, declaration);
        return new AdminResult(A.OkStatus, { [A.NameField]: name });
    }

    private async DeleteApplication(realmId: string, name: string): Promise<AdminResult>
    {
        return new AdminResult(IdpAdminEndpoint.OkStatus, { [IdpAdminEndpoint.RemovedField]: await this.stores.Applications.Remove(realmId, name) });
    }

    /** Stores one realm secret (`secret:realm/<name>` in the realm's configuration); the value is never echoed. */
    private async PutSecret(realmId: string, name: string, body: unknown): Promise<AdminResult>
    {
        const A = IdpAdminEndpoint;
        const value = A.NonEmptyString(A.AsRecord(body)?.[A.ValueField]);
        if (!A.SecretName.test(name) || value === undefined)
        {
            return A.InvalidBody();
        }
        await this.stores.Realms.For(realmId)!.Secrets.Put(name, value);
        return new AdminResult(A.OkStatus, { [A.NameField]: name });
    }

    private async DeleteSecret(realmId: string, name: string): Promise<AdminResult>
    {
        const A = IdpAdminEndpoint;
        if (!A.SecretName.test(name))
        {
            return A.InvalidBody();
        }
        await this.stores.Realms.For(realmId)!.Secrets.Delete(name);
        return new AdminResult(A.OkStatus, { [A.NameField]: name });
    }

    private static MappingOf(body: unknown): RoleMapping | undefined
    {
        const A = IdpAdminEndpoint;
        const fields = A.AsRecord(body);
        const member = A.AsRecord(fields?.[A.MemberField]);
        const role = fields?.[A.RoleField];
        const kind = member?.[A.KindField];
        const source = member?.[A.SourceField] ?? A.NoSource;
        const value = member?.[A.ValueField];
        if (typeof role !== 'string' || typeof kind !== 'string' || typeof source !== 'string' || typeof value !== 'string')
        {
            return undefined;
        }
        const parsedMember = RoleMember.From(kind, source, value);
        let parsedRole: RealmRole;
        try
        {
            parsedRole = RealmRole.Parse(role);
        }
        catch (err)
        {
            if (err instanceof InvalidRealmRoleError)
            {
                return undefined;
            }
            throw err;
        }
        return parsedMember === null ? undefined : new RoleMapping(parsedRole, parsedMember);
    }

    private static MappingJson(mapping: RoleMapping): Record<string, unknown>
    {
        const A = IdpAdminEndpoint;
        return {
            [A.RoleField]: mapping.Role.ToString(),
            [A.MemberField]: { [A.KindField]: mapping.Member.Kind, [A.SourceField]: mapping.Member.Source, [A.ValueField]: mapping.Member.Value },
        };
    }

    private static Digest(value: string): Buffer
    {
        return createHash(IdpAdminEndpoint.HashAlgorithm).update(value).digest();
    }

    private static AsRecord(body: unknown): Record<string, unknown> | undefined
    {
        if (typeof body !== 'object' || body === null || Array.isArray(body))
        {
            return undefined;
        }
        return body as Record<string, unknown>;
    }

    private static NonEmptyString(value: unknown): string | undefined
    {
        return typeof value === 'string' && value.length > 0 ? value : undefined;
    }

    private static AbsoluteUrlList(value: unknown, mayBeEmpty: boolean): string[] | undefined
    {
        if (!Array.isArray(value) || (value.length === 0 && !mayBeEmpty))
        {
            return undefined;
        }
        const out: string[] = [];
        for (const item of value)
        {
            const entry = IdpAdminEndpoint.NonEmptyString(item);
            if (entry === undefined || !IdpAdminEndpoint.IsRedirectUri(entry))
            {
                return undefined;
            }
            out.push(entry);
        }
        return out;
    }

    /** A redirect a client may register: https, or http to a loopback host (a native app, RFC 8252); never a fragment. */
    private static IsRedirectUri(text: string): boolean
    {
        const A = IdpAdminEndpoint;
        if (!URL.canParse(text))
        {
            return false;
        }
        const url = new URL(text);
        const transport = url.protocol === A.HttpsProtocol || (url.protocol === A.HttpProtocol && A.LoopbackHosts.has(url.hostname));
        return transport && url.hash === '' && url.username === '' && url.password === '';
    }

    private static InvalidBody(): AdminResult
    {
        return IdpAdminEndpoint.Fail(IdpAdminEndpoint.BadRequestStatus, IdpAdminEndpoint.InvalidBodyCode);
    }

    private static NotFound(): AdminResult
    {
        return IdpAdminEndpoint.Fail(IdpAdminEndpoint.NotFoundStatus, IdpAdminEndpoint.NotFoundCode);
    }

    private static Fail(status: number, code: string): AdminResult
    {
        return new AdminResult(status, { [IdpAdminEndpoint.ErrorField]: code });
    }
}
