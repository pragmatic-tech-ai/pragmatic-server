import { AppHost, AppHostConfig, AuditTrail, HttpMethod, ProblemMapper, RouteAuth, RouteTable, SecurityHeaders, type RequestContext } from '@pragmatic-tech-ai/pragmatic-app-host';
import type { ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component';
import { ApplicationDeclaration, RealmIssuer } from '@pragmatic-tech-ai/pragmatic-identity';
import { RealmRoleResolver, RoleMappingService, TenantRoleRegistry } from '@pragmatic-tech-ai/pragmatic-identity-realm';
import { SecretStoreDirectory } from '@pragmatic-tech-ai/pragmatic-configuration';
import { SignInEndpoints } from './authorize-endpoint.js';
import { FileSecretStore } from './file-secret-store.js';
import { IdpAdminEndpoint, IdpAdminStores } from './idp-admin-endpoint.js';
import { IdpFormRoutes, type IFormEndpoint } from './idp-form-routes.js';
import type { IdpLoginPage } from './idp-login-page.js';
import { IdpLoginThrottles } from './idp-login-throttles.js';
import { IdpRealm, IdpSourceClients } from './idp-realm.js';
import { IdpRealmSet, type IRealmOpener } from './idp-realm-set.js';
import type { IdpSigningKey } from './idp-signing-key.js';
import type { IdpTlsIdentity } from './idp-tls-identity.js';
import { ProtocolEndpoints } from './protocol-endpoints.js';
import type { IRealmSecretsHome, RealmConfiguration } from './realm-configuration-reader.js';
import type { RealmSettings } from './realm-settings.js';
import { RealmTokenIssuer } from './realm-token-issuer.js';
import { SignInCompletion } from './sign-in-completion.js';
import type { TenantIdpDatabase, TenantIdpStores } from './tenant-idp-database.js';
import { RevocationEndpoint, TokenEndpoint } from './token-endpoint.js';

/**
 * A realm's secrets home as the configuration reader resolves references through it: `realm` = the realm's sealed
 * store in the service's database, `file` = the secret files of the secrets directory (when one is set).
 */
export class TenantIdpSecretsHome implements IRealmSecretsHome
{
    public static readonly RealmStore = 'realm';
    public static readonly FileStore = 'file';

    public constructor(private readonly database: TenantIdpDatabase, private readonly masterKey: Buffer, private readonly secretsDir: string | undefined)
    {
    }

    public async DirectoryFor(realm: string): Promise<SecretStoreDirectory>
    {
        const directory = new SecretStoreDirectory().Add(TenantIdpSecretsHome.RealmStore, await this.database.RealmSecrets(realm, this.masterKey));
        if (this.secretsDir !== undefined)
        {
            directory.Add(TenantIdpSecretsHome.FileStore, new FileSecretStore(this.secretsDir));
        }
        return directory;
    }
}

/** How the service is put together (IdpMain reads these from the environment; tests build them directly). */
export interface TenantIdpServiceOptions
{
    Database: TenantIdpDatabase;
    SigningKey: IdpSigningKey;
    MasterKey: Buffer;
    /** The browser-facing origin; a realm's issuer is `<BaseUrl>/realms/<realm>`. */
    BaseUrl: string;
    /** The in-cluster origin of the token, key and revocation endpoints, when it differs. */
    InternalBaseUrl?: string;
    Configurations: readonly RealmConfiguration[];
    /** Component descriptors whose application roles every realm offers for mapping. */
    Applications: readonly ComponentDescriptor[];
    LoginPage: IdpLoginPage;
    SecureCookie: boolean;
    TrustedProxy: boolean;
    /** Serve TLS with this identity (the in-hive service); absent: plain HTTP behind a TLS-terminating proxy. */
    Tls?: IdpTlsIdentity;
    /** The admin API's tokens; absent: no admin API. */
    AdminTokens?: readonly string[];
    SourceClients?: IdpSourceClients;
    Now?: () => Date;
}

/**
 * The realm sign-in service (`pragmatic-tenant-idp`) on pragmatic-app-host: one AppHost serving every realm's
 * discovery, keys, authorize, login, upstream broker, token, revocation and logout endpoints, the sign-in app's assets
 * and the admin API, over the service's own Postgres stores. The form-bodied token and revocation endpoints and the
 * TLS listener ride the two hooks of the plan's gaps G1 and G2.
 */
export class TenantIdpService
{
    private static readonly AdminPattern = '/_admin/*';
    private static readonly LoginAssetPattern = '/_login/*';
    private static readonly RestParam = '*';
    private static readonly PathSeparator = '/';
    private static readonly AdminBodyLimit = 256 * 1024;
    private static readonly ApiPrefix = '/_admin/';
    private static readonly IdentityToolkitOrigin = 'https://identitytoolkit.googleapis.com';
    private static readonly SecureTokenOrigin = 'https://securetoken.googleapis.com';
    private static readonly SelfConnect = "connect-src 'self'";
    private static readonly Space = ' ';
    private static readonly ContentTypeHeader = 'Content-Type';
    private static readonly CacheControlHeader = 'Cache-Control';
    private static readonly NoStore = 'no-store';
    private static readonly StatusOk = 200;
    private static readonly StatusNotFound = 404;
    private static readonly ErrorField = 'error';
    private static readonly NotFoundCode = 'not_found';
    private static readonly UnauthorizedCode = 'unauthorized';
    private static readonly StatusUnauthorized = 401;
    private static readonly LogPrefix = '[tenant-idp]';

    private constructor(
        public readonly Realms: IdpRealmSet,
        public readonly Stores: TenantIdpStores,
        public readonly Discovery: ProtocolEndpoints,
        private readonly host: AppHost)
    {
    }

    public static async Open(options: TenantIdpServiceOptions): Promise<TenantIdpService>
    {
        const S = TenantIdpService;
        const now = options.Now ?? (() => new Date());
        const stores = await options.Database.Stores(now);
        const applications = options.Applications.map(descriptor => ApplicationDeclaration.FromDescriptor(descriptor));
        const opener = new TenantIdpRealmOpener(options, stores, applications, now);
        const realms = await IdpRealmSet.Open(opener, stores.Realms, options.Configurations);
        const roles = new RoleMappingService(TenantRoleRegistry.Standard, stores.Applications, stores.RoleMappings);
        const resolver = new RealmRoleResolver(TenantRoleRegistry.Standard, stores.Applications, stores.RoleMappings);
        const issuer = new RealmTokenIssuer(options.SigningKey, resolver, now);
        const completion = new SignInCompletion(stores.Codes, stores.Sso, stores.RefreshTokens, options.SecureCookie);
        const throttles = new IdpLoginThrottles(stores.Throttles, () => now().getTime());
        const signIn = new SignInEndpoints(realms, stores.Clients, stores.Sso, completion, options.LoginPage, throttles, options.SecureCookie, now);
        const protocol = new ProtocolEndpoints(realms, stores.Clients, stores.Sso, stores.RefreshTokens, options.SigningKey, options.InternalBaseUrl, options.SecureCookie);
        const routes = new RouteTable();
        signIn.Register(routes);
        protocol.Register(routes);
        new IdpFormRoutes(new Map<string, IFormEndpoint>([
            [RealmIssuer.TokenPath, new TokenEndpoint(realms, stores.Clients, stores.Codes, stores.RefreshTokens, stores.Sso, issuer)],
            [RealmIssuer.RevocationPath, new RevocationEndpoint(realms, stores.Clients, stores.RefreshTokens)],
        ])).Register(routes);
        S.RegisterAssets(routes, options.LoginPage);
        if (options.AdminTokens !== undefined && options.AdminTokens.length > 0)
        {
            const admin = new IdpAdminEndpoint(options.AdminTokens, new IdpAdminStores(realms, stores.Clients, stores.Sso, stores.RefreshTokens, roles, stores.Applications));
            S.RegisterAdmin(routes, admin);
        }
        const config = new AppHostConfig({
            AllowedHosts: S.HostsOf(options.BaseUrl, options.InternalBaseUrl),
            TrustedProxy: options.TrustedProxy,
            ApiPrefix: S.ApiPrefix,
            Security: { ContentSecurityPolicy: S.ContentSecurityPolicy() },
            Tls: options.Tls,
        });
        const host = new AppHost(config, {
            Routes: routes,
            Audit: new AuditTrail(stores.HostAudit),
            Problems: new ProblemMapper(err => console.error(S.LogPrefix, err instanceof Error ? err.name : typeof err)),
        });
        return new TenantIdpService(realms, stores, protocol, host);
    }

    /** Serves HTTPS when the options carry a TLS identity (the host terminates it), plain HTTP otherwise. */
    public async Listen(port: number, bind: string): Promise<void>
    {
        await this.host.Listen(port, bind);
    }

    public Address(): { address: string; port: number }
    {
        return this.host.Address();
    }

    public async Close(): Promise<void>
    {
        await this.host.Close();
    }

    /** The default policy with the Identity Platform REST origins the login page calls added to `connect-src`. */
    public static ContentSecurityPolicy(): string
    {
        const S = TenantIdpService;
        return SecurityHeaders.DefaultContentSecurityPolicy.replace(S.SelfConnect, S.SelfConnect + S.Space + S.IdentityToolkitOrigin + S.Space + S.SecureTokenOrigin);
    }

    private static HostsOf(baseUrl: string, internalBaseUrl: string | undefined): string[]
    {
        const hosts = [new URL(baseUrl).hostname];
        if (internalBaseUrl !== undefined)
        {
            hosts.push(new URL(internalBaseUrl).hostname);
        }
        return hosts;
    }

    private static RegisterAssets(routes: RouteTable, page: IdpLoginPage): void
    {
        const S = TenantIdpService;
        routes.Add({
            Method: HttpMethod.Get, Pattern: S.LoginAssetPattern, Auth: RouteAuth.Public, Handler: async (ctx: RequestContext) =>
            {
                const asset = page.ReadAsset(ctx.Param(S.RestParam));
                if (asset === undefined)
                {
                    ctx.WriteJson(S.StatusNotFound, { [S.ErrorField]: S.NotFoundCode });
                    return;
                }
                ctx.Response.writeHead(S.StatusOk, { [S.ContentTypeHeader]: asset.contentType, [S.CacheControlHeader]: asset.cacheControl });
                ctx.Response.end(asset.bytes);
            },
        });
    }

    private static RegisterAdmin(routes: RouteTable, admin: IdpAdminEndpoint): void
    {
        const S = TenantIdpService;
        for (const method of [HttpMethod.Get, HttpMethod.Put, HttpMethod.Post, HttpMethod.Delete])
        {
            routes.Add({
                Method: method, Pattern: S.AdminPattern, Auth: RouteAuth.Public, Audited: method !== HttpMethod.Get, BodyLimit: S.AdminBodyLimit, Handler: async (ctx: RequestContext) =>
                {
                    let segments: string[];
                    try
                    {
                        segments = ctx.Param(S.RestParam).split(S.PathSeparator).map(segment => decodeURIComponent(segment));
                    }
                    catch
                    {
                        ctx.WriteJson(S.StatusNotFound, { [S.ErrorField]: S.NotFoundCode });
                        return;
                    }
                    if (!admin.IsAdminCredential(ctx.Request.headers.authorization))
                    {
                        // The token is checked before any body is read (it is drained unread).
                        ctx.Request.resume();
                        ctx.WriteJson(S.StatusUnauthorized, { [S.ErrorField]: S.UnauthorizedCode });
                        return;
                    }
                    const body = method === HttpMethod.Get ? undefined : await ctx.ReadJson();
                    const result = await admin.Handle(method, segments, ctx.Request.headers.authorization, body);
                    ctx.Response.setHeader(S.CacheControlHeader, S.NoStore);
                    ctx.WriteJson(result.Status, result.Body);
                },
            });
        }
    }
}

/** Opens a realm over the service's stores: its issuer, its sealed secrets, its sources; declares the descriptor-fed
 *  applications into it. */
class TenantIdpRealmOpener implements IRealmOpener
{
    public constructor(
        private readonly options: TenantIdpServiceOptions,
        private readonly stores: TenantIdpStores,
        private readonly applications: readonly ApplicationDeclaration[],
        private readonly now: () => Date)
    {
    }

    public async Open(settings: RealmSettings): Promise<IdpRealm>
    {
        const secrets = await this.options.Database.RealmSecrets(settings.RealmId, this.options.MasterKey);
        for (const application of this.applications)
        {
            await this.stores.Applications.Declare(settings.RealmId, application);
        }
        const issuer = RealmIssuer.Of(this.options.BaseUrl, settings.RealmId);
        return IdpRealm.Open(settings, issuer, this.stores, secrets, this.options.SourceClients ?? IdpSourceClients.Default, this.now);
    }
}
