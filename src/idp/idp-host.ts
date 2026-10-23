import { createServer } from 'node:https';
import type { Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IAuthorizationCodeStore } from './authorization-code-store.js';
import type { IdpClientStore } from './idp-client-store.js';
import type { IdpRealm } from './idp-realm.js';
import type { IdpSigningKey } from './idp-signing-key.js';
import type { IdpSsoSessionStore } from './idp-sso-session.js';

/** Tenant id -> realm lookup for the IdP host. Keyed by the real platform tenant id. */
export class IdpRealmSet
{
    private readonly realms = new Map<string, IdpRealm>();

    public constructor(entries: Iterable<readonly [string, IdpRealm]> = [])
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
    private static readonly IssuerField = 'issuer';
    private static readonly AuthorizationEndpointField = 'authorization_endpoint';
    private static readonly TokenEndpointField = 'token_endpoint';
    private static readonly JwksUriField = 'jwks_uri';
    private static readonly ErrorField = 'error';

    private httpsServer: Server | undefined;
    private readonly baseUrl: string;

    public constructor(
        baseUrl: string,
        private readonly signingKey: IdpSigningKey,
        private readonly realms: IdpRealmSet,
        protected readonly clients: IdpClientStore,
        protected readonly codes: IAuthorizationCodeStore,
        protected readonly sso: IdpSsoSessionStore,
        private readonly tls: { key: Buffer; cert: Buffer },
        protected readonly secureCookie: boolean)
    {
        if (new URL(baseUrl).protocol !== IdpHost.HttpsProtocol)
        {
            throw new Error(IdpHost.NotHttpsMessage);
        }
        this.baseUrl = baseUrl.replace(/\/+$/, '');
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

    /** Returns false when the request matches no route (caller answers 404). Tasks 8/9 add authorize/token here. */
    private async RouteApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>
    {
        const method = req.method ?? IdpHost.MethodGet;
        const segments = path.split(IdpHost.PathSeparator).slice(1);
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
        return false;
    }

    private Discovery(tenantId: string): Record<string, string>
    {
        const issuer = `${this.baseUrl}/${encodeURIComponent(tenantId)}`;
        return {
            [IdpHost.IssuerField]: issuer,
            [IdpHost.AuthorizationEndpointField]: `${issuer}/${IdpHost.AuthorizeRest}`,
            [IdpHost.TokenEndpointField]: `${issuer}/${IdpHost.TokenRest}`,
            [IdpHost.JwksUriField]: `${issuer}/${IdpHost.JwksRest}`
        };
    }

    private WriteNotFound(res: ServerResponse): void
    {
        this.WriteJson(res, IdpHost.StatusNotFound, { [IdpHost.ErrorField]: IdpHost.NotFoundMessage });
    }

    private WriteJson(res: ServerResponse, status: number, body: unknown): void
    {
        res.writeHead(status, { [IdpHost.ContentType]: IdpHost.JsonType });
        res.end(JSON.stringify(body));
    }
}
