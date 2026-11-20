import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { CaTrustingHttpClient, SessionClaims, type IOidcClientConfig, type IOidcClientProvider } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity'
import type { IIdpService } from '../idp-service.js'
import type { IdpAdminClient } from '../idp-admin-client.js'
import type { IdpConnection } from '../idp-workload-driver.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import type { TenantAdminClientRegistry } from './tenant-admin-client-record.js'
import { TenantSessionClaims } from './tenant-sessions.js'
import { RealmIssuer } from '../../../src/idp/realm-issuer.js'

/** Which confidential client a sign-in runs under: the tenant console's, or the Plexus desktop app's (RFC 8252 loopback). */
export enum TenantOidcClientKind
{
    Console = 'console',
    Desktop = 'desktop',
}

/** Where a request's host leads: its tenant and the console's OIDC callback on that host (TenantHostResolver). */
export interface ITenantCallbacks
{
    TenantFor(hostHeader: string | undefined): string | undefined
    CallbackFor(hostHeader: string): string
}

/** The console's OIDC clients: the console client of a request's host (IOidcClientProvider) and any client by kind. */
export interface ITenantOidcClients extends IOidcClientProvider
{
    For(kind: TenantOidcClientKind, tenantId: string, callbackUrl: string): Promise<IOidcClientConfig>
}

/** The request's host is not a known tenant's: no client, so the sign-in is refused (the host's guard refuses it first). */
export class UnknownTenantHostError extends Error
{
    private static readonly ErrorName = 'UnknownTenantHostError'
    private static readonly Text = 'The request host is not a tenant of this console.'

    public constructor()
    {
        super(UnknownTenantHostError.Text)
        this.name = UnknownTenantHostError.ErrorName
    }
}

/**
 * One client kind's IdP coordinates for a tenant: its client id, its own secret ref and registry row (so the console and
 * desktop clients never overwrite each other's secret), and the redirect it registers. The console registers the exact
 * per-request callback; the desktop registers the portless loopback URI, which the IdP matches on any port (RFC 8252 7.3),
 * while its authorize request and code exchange carry the port-ful callback.
 */
class TenantOidcClient
{
    public static readonly ConsoleClientId = 'pragmatic-tenant-admin'
    public static readonly DesktopClientId = 'pragmatic-desktop'
    private static readonly ConsoleSecretRefPrefix = 'tenant-admin-oidc/'
    private static readonly DesktopSecretRefPrefix = 'tenant-desktop-oidc/'
    /** The desktop client's registered redirect: loopback with no port, so the IdP matches any port (RFC 8252 sec. 7.3). */
    public static readonly DesktopRegisteredRedirect = 'http://127.0.0.1/pragmatic-desktop/callback'

    private constructor(
        public readonly ClientId: string,
        public readonly SecretRef: string,
        public readonly RegistryId: string,
        public readonly RegisteredRedirect: string)
    {
    }

    public static For(kind: TenantOidcClientKind, tenantId: string, callbackUrl: string): TenantOidcClient
    {
        if (kind === TenantOidcClientKind.Desktop)
        {
            const ref = TenantOidcClient.DesktopSecretRefPrefix + tenantId
            return new TenantOidcClient(TenantOidcClient.DesktopClientId, ref, ref, TenantOidcClient.DesktopRegisteredRedirect)
        }
        // The console row keeps its historical id (the tenant id), so existing registries are read unchanged.
        return new TenantOidcClient(TenantOidcClient.ConsoleClientId, TenantOidcClient.ConsoleSecretRefPrefix + tenantId, tenantId, callbackUrl)
    }
}

/** What TenantOidcClients needs beyond the IdP: the secret store, the registry of rotation times and the secret lifetime. */
export interface TenantOidcClientSecrets
{
    /** The sealed secret store the client secrets live in (SqlSecretStore under the master key). */
    readonly Store: ISecretStore
    /** One row per client: its secret ref and when the secret was last rotated (never the secret itself). */
    readonly Registry: TenantAdminClientRegistry
    readonly TtlMs: number
    readonly Now?: () => number
}

/**
 * The tenant console's OIDC clients at its tenants' realm sign-in services (the application-supplied piece of the app-host
 * relying party): the realm comes from the request's host, the IdP connection from the IIdpService, and the confidential
 * client is registered at the IdP under a secret kept in the sealed secret store and rotated once it is older than the
 * TTL (concurrent sign-ins of one client share one mint). The client registration is repeated only when the secret or
 * the redirect changed since this process last registered it. Every session it signs in carries the tenant as a fixed
 * claim. Secrets are never returned in an error, logged or echoed.
 */
export class TenantOidcClients implements ITenantOidcClients
{
    /** The console's client id at the IdP (unchanged). */
    public static readonly ConsoleClientId = TenantOidcClient.ConsoleClientId
    /** The redirect the desktop client is registered with (the IdP matches it on any loopback port). */
    public static readonly DesktopRegisteredRedirect = TenantOidcClient.DesktopRegisteredRedirect
    /** The application name the realm knows the console by: the session keeps its `app_roles` entry. */
    public static readonly Application = 'pragmatic-tenant-admin'
    private static readonly HostHeader = 'host'
    private static readonly SecretBytes = 24
    private static readonly SecretEncoding = 'base64url'

    private readonly inFlight = new Map<string, Promise<string>>()
    /** secretRef -> the secret and redirect this process last registered at the IdP. */
    private readonly registered = new Map<string, { secret: string; redirect: string }>()

    public constructor(
        private readonly idp: IIdpService,
        private readonly directory: Pick<ITenantDirectory, 'GetTenant'>,
        private readonly adminClientFactory: (conn: IdpConnection) => IdpAdminClient,
        private readonly hosts: ITenantCallbacks,
        private readonly secrets: TenantOidcClientSecrets)
    {
    }

    /** The console client of the request's host (OidcLoginEndpoint's begin and callback). */
    public async ClientFor(req: IncomingMessage): Promise<IOidcClientConfig>
    {
        const host = req.headers[TenantOidcClients.HostHeader] as string | undefined
        const tenantId = this.hosts.TenantFor(host)
        if (tenantId === undefined || host === undefined)
        {
            throw new UnknownTenantHostError()
        }
        return await this.For(TenantOidcClientKind.Console, tenantId, this.hosts.CallbackFor(host))
    }

    /** The client of `kind` for `tenantId`, its authorize request and code exchange carrying `callbackUrl`. */
    public async For(kind: TenantOidcClientKind, tenantId: string, callbackUrl: string): Promise<IOidcClientConfig>
    {
        const client = TenantOidcClient.For(kind, tenantId, callbackUrl)
        const conn = await this.idp.EnsureForTenant(tenantId, this.DisplayNameFor(tenantId))
        const secret = await this.SecretFor(tenantId, client)
        await this.Register(conn, tenantId, client, secret)
        return {
            Issuer: TenantOidcClients.IssuerFor(conn, tenantId),
            DiscoveryUrl: TenantOidcClients.DiscoveryUrlFor(conn, tenantId),
            ClientId: client.ClientId,
            RedirectUri: callbackUrl,
            ClientSecret: secret,
            Application: TenantOidcClients.Application,
            FixedClaims: SessionClaims.From({ [TenantSessionClaims.TenantClaim]: tenantId }),
            Http: new CaTrustingHttpClient(conn.ca),
        }
    }

    /** The OIDC issuer: the browser-facing origin (equals the internal one on single-host deployments). */
    public static IssuerFor(conn: IdpConnection, tenantId: string): string
    {
        return RealmIssuer.Of(conn.browserBaseUrl, tenantId)
    }

    /** The discovery document URL, fetched over the internal origin. */
    public static DiscoveryUrlFor(conn: IdpConnection, tenantId: string): string
    {
        return RealmIssuer.DiscoveryOf(conn.baseUrl, tenantId)
    }

    private DisplayNameFor(tenantId: string): string
    {
        return this.directory.GetTenant(tenantId)?.displayName ?? tenantId
    }

    private async Register(conn: IdpConnection, tenantId: string, client: TenantOidcClient, secret: string): Promise<void>
    {
        const last = this.registered.get(client.SecretRef)
        if (last !== undefined && last.secret === secret && last.redirect === client.RegisteredRedirect)
        {
            return
        }
        await this.adminClientFactory(conn).RegisterClient(tenantId, { clientId: client.ClientId, redirectUris: [client.RegisteredRedirect], secret })
        this.registered.set(client.SecretRef, { secret, redirect: client.RegisteredRedirect })
    }

    /** The stored secret until it ages past the TTL, coalescing concurrent calls per client. */
    private SecretFor(tenantId: string, client: TenantOidcClient): Promise<string>
    {
        // Keyed by the secret ref, so a console and a desktop sign-in racing for one tenant never share a secret.
        const pending = this.inFlight.get(client.SecretRef)
        if (pending !== undefined)
        {
            return pending
        }
        const minted = this.MintOrReuse(tenantId, client).finally(() => this.inFlight.delete(client.SecretRef))
        this.inFlight.set(client.SecretRef, minted)
        return minted
    }

    private async MintOrReuse(tenantId: string, client: TenantOidcClient): Promise<string>
    {
        const now = this.secrets.Now ?? (() => Date.now())
        const record = this.secrets.Registry.Get(client.RegistryId)
        const existing = await this.secrets.Store.Get(client.SecretRef)
        // A corrupted/unparseable rotatedAt counts as aged, so a bad row forces a rotation rather than freezing the secret forever.
        const parsed = record === undefined ? Number.NaN : Date.parse(record.rotatedAt)
        const aged = record !== undefined && (Number.isNaN(parsed) || (now() - parsed) > this.secrets.TtlMs)
        if (record === undefined || existing === null || aged)
        {
            const secret = randomBytes(TenantOidcClients.SecretBytes).toString(TenantOidcClients.SecretEncoding)
            await this.secrets.Store.Put(client.SecretRef, secret)
            await this.secrets.Registry.Put({ id: client.RegistryId, tenantId, clientId: client.ClientId, secretRef: client.SecretRef, rotatedAt: new Date(now()).toISOString() })
            return secret
        }
        return existing
    }
}
