import { createServer } from 'node:https';
import type { Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IAuthorizationCodeStore } from './authorization-code-store.js';
import { AuthorizeEndpoint } from './authorize-endpoint.js';
import type { AuthorizeResult } from './authorize-endpoint.js';
import { TokenEndpoint } from './token-endpoint.js';
import type { IdpAdminEndpoint } from './idp-admin-endpoint.js';
import type { IdpClientStore } from './idp-client-store.js';
import type { IdpRealm } from './idp-realm.js';
import type { IdpSigningKey } from './idp-signing-key.js';
import type { IdpSsoSessionStore } from './idp-sso-session.js';

/** Creates (and persists) a realm for a tenant on demand. */
export type RealmFactory = (tenantId: string, displayName: string) => Promise<IdpRealm>;

/** Thrown when a realm key is reserved or malformed (empty, leading underscore, path-like). */
export class ReservedRealmError extends Error
{
    private static readonly MessagePrefix = 'Reserved or invalid realm key: ';
    private static readonly ErrorName = 'ReservedRealmError';
    private static readonly MaxKeyChars = 64;

    public constructor(key: string)
    {
        super(ReservedRealmError.MessagePrefix + JSON.stringify(key.slice(0, ReservedRealmError.MaxKeyChars)));
        this.name = ReservedRealmError.ErrorName;
    }
}

/** Tenant id -> realm lookup for the IdP host. Keyed by the real platform tenant id. */
export class IdpRealmSet
{
    private static readonly ReservedPrefix = '_';
    private static readonly ForbiddenFragments = ['/', '\\', '..'];
    private static readonly NoFactoryMessage = 'IdpRealmSet: realm creation unsupported (no factory configured)';

    private readonly realms = new Map<string, IdpRealm>();
    private readonly pending = new Map<string, Promise<IdpRealm>>();

    public constructor(
        entries: Iterable<readonly [string, IdpRealm]> = [],
        private readonly factory?: RealmFactory)
    {
        for (const [tenantId, realm] of entries)
        {
            this.Add(tenantId, realm);
        }
    }

    public Add(tenantId: string, realm: IdpRealm): void
    {
        this.realms.set(tenantId, realm);
    }

    public For(tenantId: string): IdpRealm | undefined
    {
        return this.realms.get(tenantId);
    }

    /** Returns the tenant's realm, creating it via the factory when absent. Idempotent. */
    public async EnsureRealm(tenantId: string, displayName: string): Promise<IdpRealm>
    {
        if (!IdpRealmSet.ValidKey(tenantId))
        {
            throw new ReservedRealmError(tenantId);
        }
        const existing = this.For(tenantId);
        if (existing !== undefined)
        {
            return existing;
        }
        const inFlight = this.pending.get(tenantId);
        if (inFlight !== undefined)
        {
            return inFlight;
        }
        if (this.factory === undefined)
        {
            throw new Error(IdpRealmSet.NoFactoryMessage);
        }
        const creation = this.Create(this.factory, tenantId, displayName);
        this.pending.set(tenantId, creation);
        try
        {
            return await creation;
        }
        finally
        {
            this.pending.delete(tenantId);
        }
    }

    private async Create(factory: RealmFactory, tenantId: string, displayName: string): Promise<IdpRealm>
    {
        const realm = await factory(tenantId, displayName);
        this.realms.set(tenantId, realm);
        return realm;
    }

    private static ValidKey(key: string): boolean
    {
        if (key.length === 0 || key.startsWith(IdpRealmSet.ReservedPrefix))
        {
            return false;
        }
        return !IdpRealmSet.ForbiddenFragments.some(f => key.includes(f));
    }
}

/** HTTPS host for the local OIDC identity provider; routes `/<tenantId>/<rest>` per tenant realm. */
export class IdpHost
{
    private static readonly HttpsProtocol = 'https:';
    private static readonly NotHttpsMessage = 'IdpHost: baseUrl must be https';
    private static readonly NotListeningMessage = 'IdpHost is not listening';
    private static readonly ContentType = 'Content-Type';
    private static readonly JsonType = 'application/json; charset=utf-8';
    private static readonly MethodGet = 'GET';
    private static readonly MethodPost = 'POST';
    private static readonly HtmlType = 'text/html; charset=utf-8';
    private static readonly LocationHeader = 'Location';
    private static readonly SetCookieHeader = 'Set-Cookie';
    private static readonly CacheControlHeader = 'Cache-Control';
    private static readonly NoStore = 'no-store';
    private static readonly PragmaHeader = 'Pragma';
    private static readonly NoCache = 'no-cache';
    private static readonly StatusFound = 302;
    private static readonly StatusPayloadTooLarge = 413;
    private static readonly MaxFormBytes = 16 * 1024;
    private static readonly PayloadTooLargeMessage = 'payload too large';
    private static readonly RootUrl = 'https://idp.invalid';
    private static readonly PathSeparator = '/';
    private static readonly StatusOk = 200;
    private static readonly StatusNotFound = 404;
    private static readonly StatusServerError = 500;
    private static readonly NotFoundMessage = 'not found';
    private static readonly ServerErrorMessage = 'internal error';
    private static readonly DiscoveryRest = '.well-known/openid-configuration';
    private static readonly JwksRest = 'jwks';
    private static readonly AuthorizeRest = 'authorize';
    private static readonly TokenRest = 'token';
    private static readonly PasswordRest = 'password';
    private static readonly EmailField = 'email';
    private static readonly CurrentPasswordField = 'currentPassword';
    private static readonly NewPasswordField = 'newPassword';
    private static readonly StatusUnauthorized = 401;
    private static readonly InvalidCredentialsCode = 'invalid_credentials';
    private static readonly InvalidRequestCode = 'invalid_request';
    private static readonly EmptyObject = {};
    private static readonly IssuerField = 'issuer';
    private static readonly AuthorizationEndpointField = 'authorization_endpoint';
    private static readonly TokenEndpointField = 'token_endpoint';
    private static readonly JwksUriField = 'jwks_uri';
    private static readonly ErrorField = 'error';
    private static readonly NoStoreHeaders: Record<string, string> = { [IdpHost.CacheControlHeader]: IdpHost.NoStore };
    private static readonly AdminSegment = '_admin';
    private static readonly AuthorizationHeader = 'authorization';
    private static readonly StatusBadRequest = 400;
    private static readonly InvalidJsonMessage = 'invalid_json';
    private static readonly InternalErrorCode = 'internal_error';
    private static readonly HealthPath = '/healthz';
    private static readonly HealthStatusField = 'status';
    private static readonly HealthOkValue = 'ok';

    private httpsServer: Server | undefined;
    private readonly baseUrl: string;
    private readonly internalBaseUrl: string;
    private readonly authorize: AuthorizeEndpoint;
    private readonly token: TokenEndpoint;

    public constructor(
        baseUrl: string,
        private readonly signingKey: IdpSigningKey,
        private readonly realms: IdpRealmSet,
        private readonly clients: IdpClientStore,
        private readonly codes: IAuthorizationCodeStore,
        private readonly sso: IdpSsoSessionStore,
        private readonly tls: { key: Buffer; cert: Buffer },
        private readonly secureCookie: boolean,
        private readonly admin?: IdpAdminEndpoint,
        internalBaseUrl?: string)
    {
        if (new URL(baseUrl).protocol !== IdpHost.HttpsProtocol)
        {
            throw new Error(IdpHost.NotHttpsMessage);
        }
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.internalBaseUrl = internalBaseUrl !== undefined && internalBaseUrl.trim().length > 0 ? internalBaseUrl.replace(/\/+$/, '') : this.baseUrl;
        this.authorize = new AuthorizeEndpoint(realms, clients, codes, sso, secureCookie);
        this.token = new TokenEndpoint(this.baseUrl, signingKey, codes, clients);
    }

    public Listen(port: number, host: string): Promise<void>
    {
        const server = createServer({ key: this.tls.key, cert: this.tls.cert }, (req, res) =>
        {
            void this.Handle(req, res);
        });
        this.httpsServer = server;
        return new Promise<void>((resolve, reject) =>
        {
            server.once('error', reject);
            server.listen(port, host, () =>
            {
                server.off('error', reject);
                resolve();
            });
        });
    }

    public async Close(): Promise<void>
    {
        const server = this.httpsServer;
        this.httpsServer = undefined;
        if (server !== undefined)
        {
            server.closeAllConnections();
            await new Promise<void>(res => server.close(() => res()));
        }
    }

    public Address(): { address: string; port: number }
    {
        const a = this.httpsServer?.address() as AddressInfo | null | undefined;
        if (a === null || a === undefined)
        {
            throw new Error(IdpHost.NotListeningMessage);
        }
        return { address: a.address, port: a.port };
    }

    private async Handle(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        try
        {
            const path = new URL(req.url ?? IdpHost.PathSeparator, IdpHost.RootUrl).pathname;
            const handled = await this.RouteApi(req, res, path);
            if (!handled)
            {
                this.WriteNotFound(res);
            }
        }
        catch
        {
            if (!res.headersSent)
            {
                this.WriteJson(res, IdpHost.StatusServerError, { [IdpHost.ErrorField]: IdpHost.ServerErrorMessage });
            }
            else
            {
                res.end();
            }
        }
    }

    /** Returns false when the request matches no route (caller answers 404). */
    private async RouteApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>
    {
        const method = req.method ?? IdpHost.MethodGet;
        const segments = path.split(IdpHost.PathSeparator).slice(1);
        if (segments[0] === IdpHost.AdminSegment)
        {
            if (this.admin === undefined)
            {
                return false;
            }
            let decoded: string[];
            try
            {
                decoded = segments.slice(1).map(decodeURIComponent);
            }
            catch
            {
                return false;
            }
            await this.RouteAdmin(req, res, this.admin, method, decoded);
            return true;
        }
        if (method === IdpHost.MethodGet && path === IdpHost.HealthPath)
        {
            this.WriteJson(res, IdpHost.StatusOk, { [IdpHost.HealthStatusField]: IdpHost.HealthOkValue });
            return true;
        }
        if (segments.length < 2)
        {
            return false;
        }
        let tenantId: string;
        try
        {
            tenantId = decodeURIComponent(segments[0]);
        }
        catch
        {
            return false;
        }
        if (this.realms.For(tenantId) === undefined)
        {
            return false;
        }
        const rest = segments.slice(1).join(IdpHost.PathSeparator);
        if (method === IdpHost.MethodGet && rest === IdpHost.DiscoveryRest)
        {
            this.WriteJson(res, IdpHost.StatusOk, this.Discovery(tenantId));
            return true;
        }
        if (method === IdpHost.MethodGet && rest === IdpHost.JwksRest)
        {
            this.WriteJson(res, IdpHost.StatusOk, this.signingKey.PublicJwks());
            return true;
        }
        if (rest === IdpHost.AuthorizeRest && (method === IdpHost.MethodGet || method === IdpHost.MethodPost))
        {
            await this.RouteAuthorize(req, res, tenantId, method);
            return true;
        }
        if (rest === IdpHost.TokenRest && method === IdpHost.MethodPost)
        {
            await this.RouteToken(req, res, tenantId);
            return true;
        }
        if (rest === IdpHost.PasswordRest && method === IdpHost.MethodPost)
        {
            await this.RoutePassword(req, res, tenantId);
            return true;
        }
        return false;
    }

    /** Self-service password change: verifies the current password, then rotates. Never echoes either password. */
    private async RoutePassword(req: IncomingMessage, res: ServerResponse, tenantId: string): Promise<void>
    {
        const raw = await this.ReadBody(req);
        if (raw === undefined)
        {
            this.WriteJson(res, IdpHost.StatusPayloadTooLarge, { [IdpHost.ErrorField]: IdpHost.PayloadTooLargeMessage }, IdpHost.NoStoreHeaders);
            return;
        }
        let fields: Record<string, unknown> | undefined;
        try
        {
            const parsed: unknown = JSON.parse(raw);
            fields = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
        }
        catch
        {
            fields = undefined;
        }
        const email = fields?.[IdpHost.EmailField];
        const current = fields?.[IdpHost.CurrentPasswordField];
        const next = fields?.[IdpHost.NewPasswordField];
        const realm = this.realms.For(tenantId);
        if (realm === undefined || typeof email !== 'string' || typeof current !== 'string' || typeof next !== 'string'
            || email.length === 0 || current.length === 0 || next.length === 0)
        {
            this.WriteJson(res, IdpHost.StatusBadRequest, { [IdpHost.ErrorField]: IdpHost.InvalidRequestCode }, IdpHost.NoStoreHeaders);
            return;
        }
        if (await realm.RotatePassword(email, current, next))
        {
            this.WriteJson(res, IdpHost.StatusOk, IdpHost.EmptyObject, IdpHost.NoStoreHeaders);
            return;
        }
        this.WriteJson(res, IdpHost.StatusUnauthorized, { [IdpHost.ErrorField]: IdpHost.InvalidCredentialsCode }, IdpHost.NoStoreHeaders);
    }

    private async RouteAdmin(req: IncomingMessage, res: ServerResponse, admin: IdpAdminEndpoint, method: string, segments: string[]): Promise<void>
    {
        const raw = await this.ReadBody(req);
        if (raw === undefined)
        {
            this.WriteJson(res, IdpHost.StatusPayloadTooLarge, { [IdpHost.ErrorField]: IdpHost.PayloadTooLargeMessage }, IdpHost.NoStoreHeaders);
            return;
        }
        let parsed: unknown;
        if (raw.length > 0)
        {
            try
            {
                parsed = JSON.parse(raw);
            }
            catch
            {
                this.WriteJson(res, IdpHost.StatusBadRequest, { [IdpHost.ErrorField]: IdpHost.InvalidJsonMessage }, IdpHost.NoStoreHeaders);
                return;
            }
        }
        try
        {
            const result = await admin.Handle(method, segments, req.headers[IdpHost.AuthorizationHeader], parsed);
            this.WriteJson(res, result.Status, result.Body, IdpHost.NoStoreHeaders);
        }
        catch
        {
            this.WriteJson(res, IdpHost.StatusServerError, { [IdpHost.ErrorField]: IdpHost.InternalErrorCode }, IdpHost.NoStoreHeaders);
        }
    }

    private async RouteToken(req: IncomingMessage, res: ServerResponse, tenantId: string): Promise<void>
    {
        const body = await this.ReadBody(req);
        if (body === undefined)
        {
            this.WriteJson(res, IdpHost.StatusPayloadTooLarge, { [IdpHost.ErrorField]: IdpHost.PayloadTooLargeMessage });
            return;
        }
        const result = await this.token.Handle(tenantId, new URLSearchParams(body));
        res.writeHead(result.status, {
            [IdpHost.ContentType]: IdpHost.JsonType,
            [IdpHost.CacheControlHeader]: IdpHost.NoStore,
            [IdpHost.PragmaHeader]: IdpHost.NoCache
        });
        res.end(JSON.stringify(result.body));
    }

    private async RouteAuthorize(req: IncomingMessage, res: ServerResponse, tenantId: string, method: string): Promise<void>
    {
        const query = new URL(req.url ?? IdpHost.PathSeparator, IdpHost.RootUrl).searchParams;
        const cookieHeader = req.headers.cookie;
        let result: AuthorizeResult;
        if (method === IdpHost.MethodPost)
        {
            const body = await this.ReadBody(req);
            if (body === undefined)
            {
                this.WriteJson(res, IdpHost.StatusPayloadTooLarge, { [IdpHost.ErrorField]: IdpHost.PayloadTooLargeMessage });
                return;
            }
            result = await this.authorize.HandlePost(tenantId, query, cookieHeader, new URLSearchParams(body));
        }
        else
        {
            result = await this.authorize.HandleGet(tenantId, query, cookieHeader);
        }
        this.WriteAuthorize(res, result);
    }

    /** Reads a bounded request body; undefined when it exceeds the limit. */
    private async ReadBody(req: IncomingMessage): Promise<string | undefined>
    {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req)
        {
            const buf = chunk as Buffer;
            size += buf.length;
            if (size > IdpHost.MaxFormBytes)
            {
                return undefined;
            }
            chunks.push(buf);
        }
        return Buffer.concat(chunks).toString('utf8');
    }

    private WriteAuthorize(res: ServerResponse, result: AuthorizeResult): void
    {
        if (result.kind === 'redirect')
        {
            const headers: Record<string, string> = { [IdpHost.LocationHeader]: result.location, [IdpHost.CacheControlHeader]: IdpHost.NoStore };
            if (result.setCookie !== undefined)
            {
                headers[IdpHost.SetCookieHeader] = result.setCookie;
            }
            res.writeHead(IdpHost.StatusFound, headers);
            res.end();
        }
        else if (result.kind === 'loginPage')
        {
            res.writeHead(IdpHost.StatusOk, { [IdpHost.ContentType]: IdpHost.HtmlType, [IdpHost.CacheControlHeader]: IdpHost.NoStore });
            res.end(result.html);
        }
        else
        {
            this.WriteJson(res, result.status, result.body);
        }
    }

    private Discovery(tenantId: string): Record<string, string>
    {
        const tenantSegment = encodeURIComponent(tenantId);
        const issuer = `${this.baseUrl}/${tenantSegment}`;
        const internal = `${this.internalBaseUrl}/${tenantSegment}`;
        return {
            [IdpHost.IssuerField]: issuer,
            [IdpHost.AuthorizationEndpointField]: `${issuer}/${IdpHost.AuthorizeRest}`,
            [IdpHost.TokenEndpointField]: `${internal}/${IdpHost.TokenRest}`,
            [IdpHost.JwksUriField]: `${internal}/${IdpHost.JwksRest}`
        };
    }

    private WriteNotFound(res: ServerResponse): void
    {
        this.WriteJson(res, IdpHost.StatusNotFound, { [IdpHost.ErrorField]: IdpHost.NotFoundMessage });
    }

    private WriteJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void
    {
        res.writeHead(status, { [IdpHost.ContentType]: IdpHost.JsonType, ...extraHeaders });
        res.end(JSON.stringify(body));
    }
}
