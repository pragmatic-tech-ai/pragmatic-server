import { createHash, timingSafeEqual } from 'node:crypto';
import { ReservedRealmError } from './idp-host.js';
import type { IdpRealmSet } from './idp-host.js';
import type { IdpClientStore } from './idp-client-store.js';

/** Status + JSON body produced by the admin endpoint. Never carries secrets. */
export class AdminResult
{
    public constructor(public readonly Status: number, public readonly Body: unknown)
    {
    }
}

/**
 * Authenticated provisioning API for the local IdP (ensure realm, seed account, register client).
 * The bearer token is verified before any routing or body inspection. Nothing is logged and no
 * password / client secret / admin token ever appears in a result.
 */
export class IdpAdminEndpoint
{
    private static readonly BearerPrefix = 'Bearer ';
    private static readonly HashAlgorithm = 'sha256';
    private static readonly RealmsSegment = 'realms';
    private static readonly AccountsSegment = 'accounts';
    private static readonly ClientsSegment = 'clients';
    private static readonly PutMethod = 'PUT';
    private static readonly PostMethod = 'POST';
    private static readonly RealmPathLength = 2;
    private static readonly SubResourcePathLength = 3;
    private static readonly RealmIndex = 0;
    private static readonly TenantIndex = 1;
    private static readonly SubResourceIndex = 2;
    private static readonly OkStatus = 200;
    private static readonly BadRequestStatus = 400;
    private static readonly UnauthorizedStatus = 401;
    private static readonly NotFoundStatus = 404;
    private static readonly UnauthorizedCode = 'unauthorized';
    private static readonly InvalidBodyCode = 'invalid_body';
    private static readonly InvalidRealmCode = 'invalid_realm';
    private static readonly NotFoundCode = 'not_found';
    private static readonly UnknownRealmCode = 'unknown_realm';
    private static readonly ErrorField = 'error';
    private static readonly TenantIdField = 'tenantId';
    private static readonly PrincipalIdField = 'principalId';
    private static readonly ClientIdField = 'clientId';
    private static readonly DisplayNameField = 'displayName';
    private static readonly EmailField = 'email';
    private static readonly PasswordField = 'password';
    private static readonly RedirectUrisField = 'redirectUris';
    private static readonly SecretField = 'secret';

    private readonly adminTokenDigests: readonly Buffer[];

    /** `adminTokens` is the set of currently valid admin tokens (several during a rotation); an empty set rejects everything. */
    public constructor(
        adminTokens: readonly string[],
        private readonly realms: IdpRealmSet,
        private readonly clients: IdpClientStore)
    {
        this.adminTokenDigests = adminTokens.filter(t => t.length > 0).map(t => IdpAdminEndpoint.Digest(t));
    }

    public async Handle(method: string, segments: readonly string[], authorization: string | undefined, body: unknown): Promise<AdminResult>
    {
        if (!this.VerifyToken(authorization))
        {
            return IdpAdminEndpoint.Fail(IdpAdminEndpoint.UnauthorizedStatus, IdpAdminEndpoint.UnauthorizedCode);
        }
        if (segments[IdpAdminEndpoint.RealmIndex] !== IdpAdminEndpoint.RealmsSegment || typeof segments[IdpAdminEndpoint.TenantIndex] !== 'string')
        {
            return IdpAdminEndpoint.NotFound();
        }
        const tenantId = segments[IdpAdminEndpoint.TenantIndex]!;
        try
        {
            if (segments.length === IdpAdminEndpoint.RealmPathLength && method === IdpAdminEndpoint.PutMethod)
            {
                return await this.PutRealm(tenantId, body);
            }
            if (segments.length === IdpAdminEndpoint.SubResourcePathLength && method === IdpAdminEndpoint.PostMethod)
            {
                const sub = segments[IdpAdminEndpoint.SubResourceIndex];
                if (sub === IdpAdminEndpoint.AccountsSegment)
                {
                    return await this.PostAccount(tenantId, body);
                }
                if (sub === IdpAdminEndpoint.ClientsSegment)
                {
                    return await this.PostClient(tenantId, body);
                }
            }
        }
        catch (err)
        {
            if (err instanceof ReservedRealmError)
            {
                return IdpAdminEndpoint.Fail(IdpAdminEndpoint.BadRequestStatus, IdpAdminEndpoint.InvalidRealmCode);
            }
            throw err;
        }
        return IdpAdminEndpoint.NotFound();
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

    private async PutRealm(tenantId: string, body: unknown): Promise<AdminResult>
    {
        const fields = IdpAdminEndpoint.AsRecord(body);
        const displayName = fields === undefined ? undefined : IdpAdminEndpoint.NonEmptyString(fields[IdpAdminEndpoint.DisplayNameField]);
        if (displayName === undefined)
        {
            return IdpAdminEndpoint.InvalidBody();
        }
        await this.realms.EnsureRealm(tenantId, displayName);
        return new AdminResult(IdpAdminEndpoint.OkStatus, { [IdpAdminEndpoint.TenantIdField]: tenantId });
    }

    private async PostAccount(tenantId: string, body: unknown): Promise<AdminResult>
    {
        const fields = IdpAdminEndpoint.AsRecord(body);
        if (fields === undefined)
        {
            return IdpAdminEndpoint.InvalidBody();
        }
        const email = IdpAdminEndpoint.NonEmptyString(fields[IdpAdminEndpoint.EmailField]);
        const principalId = IdpAdminEndpoint.NonEmptyString(fields[IdpAdminEndpoint.PrincipalIdField]);
        const displayName = IdpAdminEndpoint.NonEmptyString(fields[IdpAdminEndpoint.DisplayNameField]);
        const password = IdpAdminEndpoint.NonEmptyString(fields[IdpAdminEndpoint.PasswordField]);
        if (email === undefined || principalId === undefined || displayName === undefined || password === undefined)
        {
            return IdpAdminEndpoint.InvalidBody();
        }
        const realm = this.realms.For(tenantId);
        if (realm === undefined)
        {
            return IdpAdminEndpoint.UnknownRealm();
        }
        await realm.SeedAccount(email, principalId, password, displayName);
        return new AdminResult(IdpAdminEndpoint.OkStatus, { [IdpAdminEndpoint.PrincipalIdField]: principalId });
    }

    private async PostClient(tenantId: string, body: unknown): Promise<AdminResult>
    {
        const fields = IdpAdminEndpoint.AsRecord(body);
        if (fields === undefined)
        {
            return IdpAdminEndpoint.InvalidBody();
        }
        const clientId = IdpAdminEndpoint.NonEmptyString(fields[IdpAdminEndpoint.ClientIdField]);
        const secret = IdpAdminEndpoint.NonEmptyString(fields[IdpAdminEndpoint.SecretField]);
        const redirectUris = IdpAdminEndpoint.AbsoluteUrlList(fields[IdpAdminEndpoint.RedirectUrisField]);
        if (clientId === undefined || secret === undefined || redirectUris === undefined)
        {
            return IdpAdminEndpoint.InvalidBody();
        }
        if (this.realms.For(tenantId) === undefined)
        {
            return IdpAdminEndpoint.UnknownRealm();
        }
        await this.clients.Register(tenantId, clientId, redirectUris, secret);
        return new AdminResult(IdpAdminEndpoint.OkStatus, { [IdpAdminEndpoint.ClientIdField]: clientId });
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

    private static AbsoluteUrlList(value: unknown): string[] | undefined
    {
        const list = IdpAdminEndpoint.StringList(value);
        if (list === undefined)
        {
            return undefined;
        }
        for (const entry of list)
        {
            try
            {
                new URL(entry);
            }
            catch
            {
                return undefined;
            }
        }
        return list;
    }

    private static StringList(value: unknown): string[] | undefined
    {
        if (!Array.isArray(value) || value.length === 0)
        {
            return undefined;
        }
        const out: string[] = [];
        for (const item of value)
        {
            const s = IdpAdminEndpoint.NonEmptyString(item);
            if (s === undefined)
            {
                return undefined;
            }
            out.push(s);
        }
        return out;
    }

    private static InvalidBody(): AdminResult
    {
        return IdpAdminEndpoint.Fail(IdpAdminEndpoint.BadRequestStatus, IdpAdminEndpoint.InvalidBodyCode);
    }

    private static UnknownRealm(): AdminResult
    {
        return IdpAdminEndpoint.Fail(IdpAdminEndpoint.NotFoundStatus, IdpAdminEndpoint.UnknownRealmCode);
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
