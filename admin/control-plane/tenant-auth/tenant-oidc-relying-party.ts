import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import * as https from 'node:https'
import { AuthMethod, AuthenticatedResult, Credential, DelegationDepth, IdentityConfig, PresentedSecret, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import type { IdentityStoreSet } from '@pragmatic-tech-ai/todl-identity'
import { InMemoryOidcFlowStateStore, OidcSettingKeys } from '@pragmatic-tech-ai/todl-identity-cloud'
import type { IHttpClient, IOidcFlowStateStore } from '@pragmatic-tech-ai/todl-identity-cloud'
import { FileIdentityStores } from '@pragmatic-tech-ai/todl-identity-node'
import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { IdentityPackResolver } from '../../../src/identity/identity-pack-resolver.js'
import type { IIdpService, IdpConnection } from '../idp-service.js'
import type { IdpAdminClient } from '../idp-admin-client.js'
import type { PlatformDirectory } from '../platform-directory.js'
import type { TenantAdminClientRegistry } from './tenant-admin-client-record.js'

/**
 * The optional durable dependency that turns on persistent-secret + TTL-rotation behaviour. When absent the
 * relying-party behaves exactly as before (in-memory store, random per-instance key, a fresh secret every
 * `Begin`). The registry holds only a `secretRef` name + a `rotatedAt` timestamp — never the secret itself.
 */
export type TenantAdminDurability =
{
    storeRoot: string
    masterKey: Buffer
    registry: TenantAdminClientRegistry
    secretTtlMs: number
    now?: () => number
}

/** The outcome of a completed tenant-admin login: the IdP subject (principal) and, when mapped, its email. */
export interface ITenantOidcRelyingParty
{
    Begin(tenantId: string, callbackUrl?: string): Promise<{ Url: string; State: string }>
    Complete(tenantId: string, code: string, state: string, callbackUrl?: string): Promise<{ principalId: string; email?: string }>
}

/**
 * The single failure every login path collapses to. Its message is a fixed, generic constant: the OIDC client
 * secret, the IdP admin token, the authorization code, and any inner-error text are NEVER part of it — not here,
 * not logged, not in any DTO. Callers learn only that the login did not succeed.
 */
export class TenantLoginError extends Error
{
    private static readonly ErrorName = 'TenantLoginError'
    private static readonly GenericMessage = 'Tenant administrator login failed'

    public constructor()
    {
        super(TenantLoginError.GenericMessage)
        this.name = TenantLoginError.ErrorName
    }

    /** Collapses any failure to a generic TenantLoginError, dropping the original message so nothing can leak. */
    public static From(err: unknown): TenantLoginError
    {
        return err instanceof TenantLoginError ? err : new TenantLoginError()
    }
}

/**
 * A minimal `node:https` relying-party HTTP client that trusts one tenant IdP's dev CA. It is the exact
 * `IHttpClient` surface the OIDC authenticator consumes (https-only; discovery/jwks via GET, the token
 * exchange via x-www-form-urlencoded POST). The default global-fetch client does NOT trust the per-tenant
 * DevCa, so every discovery/jwks/token fetch would fail TLS; this client is built per login from that
 * tenant's `conn.ca`. Error messages are fixed and carry neither the request URL nor the posted fields
 * (the token POST body holds the client secret and the code).
 */
class CaTrustingHttpClient implements IHttpClient
{
    private static readonly HttpsProtocol = 'https:'
    private static readonly GetMethod = 'GET'
    private static readonly PostMethod = 'POST'
    private static readonly FormContentType = 'application/x-www-form-urlencoded'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly ContentLengthHeader = 'Content-Length'
    private static readonly Utf8 = 'utf8'
    private static readonly DefaultPort = 443
    private static readonly TimeoutMs = 10000
    private static readonly OkMin = 200
    private static readonly OkMax = 300
    private static readonly NonHttpsMessage = 'tenant-oidc http client: only https URLs are permitted'
    private static readonly RequestFailedMessage = 'tenant-oidc http client: request failed'

    private readonly agent: https.Agent

    public constructor(ca: Buffer)
    {
        this.agent = new https.Agent({ ca })
    }

    public GetJson(url: string): Promise<unknown>
    {
        return this.send(CaTrustingHttpClient.GetMethod, url, undefined)
    }

    public PostForm(url: string, fields: ReadonlyMap<string, string>): Promise<unknown>
    {
        return this.send(CaTrustingHttpClient.PostMethod, url, new URLSearchParams([...fields]).toString())
    }

    private send(method: string, rawUrl: string, body: string | undefined): Promise<unknown>
    {
        const url = new URL(rawUrl)
        if (url.protocol !== CaTrustingHttpClient.HttpsProtocol)
        {
            return Promise.reject(new Error(CaTrustingHttpClient.NonHttpsMessage))
        }
        const headers: Record<string, string | number> = {}
        if (body !== undefined)
        {
            headers[CaTrustingHttpClient.ContentTypeHeader] = CaTrustingHttpClient.FormContentType
            headers[CaTrustingHttpClient.ContentLengthHeader] = Buffer.byteLength(body)
        }
        return new Promise<unknown>((resolve, reject) =>
        {
            const req = https.request({
                agent: this.agent,
                host: url.hostname,
                port: url.port === '' ? CaTrustingHttpClient.DefaultPort : Number(url.port),
                path: url.pathname + url.search,
                method,
                headers,
            }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', (c: Buffer) => chunks.push(c))
                res.on('end', () =>
                {
                    const status = res.statusCode ?? 0
                    if (status < CaTrustingHttpClient.OkMin || status >= CaTrustingHttpClient.OkMax)
                    {
                        reject(new Error(CaTrustingHttpClient.RequestFailedMessage))
                        return
                    }
                    try
                    {
                        resolve(JSON.parse(Buffer.concat(chunks).toString(CaTrustingHttpClient.Utf8)))
                    }
                    catch
                    {
                        reject(new Error(CaTrustingHttpClient.RequestFailedMessage))
                    }
                })
                res.on('error', () => reject(new Error(CaTrustingHttpClient.RequestFailedMessage)))
            })
            req.setTimeout(CaTrustingHttpClient.TimeoutMs, () =>
            {
                req.destroy()
                reject(new Error(CaTrustingHttpClient.RequestFailedMessage))
            })
            req.on('error', () => reject(new Error(CaTrustingHttpClient.RequestFailedMessage)))
            if (body !== undefined)
            {
                req.write(body)
            }
            req.end()
        })
    }
}

/**
 * Mints a tenant-admin login against the tenant's OWN per-tenant IdP via the generic-oidc pack. `Begin`
 * ensures the IdP, registers a confidential admin client under a freshly generated secret, seeds that secret
 * into an in-process secret store, and hands back the IdP authorize URL + state. `Complete` rebuilds the same
 * pack (sharing one flow-state store so the state/PKCE verifier survives Begin -> Complete) and runs the real
 * OIDC authenticator against the returned code. The client secret is generated here and never returned,
 * logged, or placed in any error; the authorization code is handled only as a transient PresentedSecret and
 * cleared in a finally.
 */
export class TenantOidcRelyingParty implements ITenantOidcRelyingParty
{
    public static readonly AdminClientId = 'pragmatic-tenant-admin'

    private static readonly GenericOidcPackId = 'generic-oidc'
    private static readonly SecretRefPrefix = 'tenant-admin-oidc/'
    private static readonly SecretBytes = 24
    private static readonly SecretEncoding = 'base64url'
    private static readonly IssuerSeparator = '/'
    private static readonly WellKnownSuffix = '/.well-known/openid-configuration'
    private static readonly EmailClaim = 'email'
    private static readonly MasterKeyBytes = 32
    private static readonly SecretDirMode = 0o700

    private readonly flowStates: IOidcFlowStateStore
    private readonly inFlight = new Map<string, Promise<string>>()
    private storesPromise: Promise<IdentityStoreSet> | undefined

    public constructor(
        private readonly idp: IIdpService,
        private readonly directory: PlatformDirectory,
        private readonly adminClientFactory: (conn: IdpConnection) => IdpAdminClient,
        private readonly callbackUrl: string,
        private readonly resolverOverride?: IdentityPackResolver,
        flowStates?: IOidcFlowStateStore,
        private readonly durability?: TenantAdminDurability)
    {
        this.flowStates = flowStates ?? new InMemoryOidcFlowStateStore()
    }

    /** True when the durable reuse/TTL path is wired (production); false means the legacy fresh-secret-each-login path. */
    public get IsDurable(): boolean
    {
        return this.durability !== undefined
    }

    public async Begin(tenantId: string, callbackUrl?: string): Promise<{ Url: string; State: string }>
    {
        try
        {
            const cb = callbackUrl ?? this.callbackUrl
            const conn = await this.idp.EnsureForTenant(tenantId, this.displayNameFor(tenantId))
            const secretRef = TenantOidcRelyingParty.SecretRefPrefix + tenantId
            const secret = this.durability === undefined
                ? await this.FreshSecretForLogin(secretRef)
                : await this.SecretForLogin(tenantId, secretRef)
            await this.adminClientFactory(conn).RegisterClient(tenantId, { clientId: TenantOidcRelyingParty.AdminClientId, redirectUris: [cb], secret })
            const stores = await this.stores()
            const tenant = this.tenantFor(tenantId)
            const resolved = this.resolverFor(conn).Resolve(tenant, this.configFor(conn, tenantId, secretRef, cb), stores)
            if (resolved.Oidc === undefined)
            {
                throw new TenantLoginError()
            }
            return await resolved.Oidc.BeginAuthorization(tenant)
        }
        catch (err)
        {
            throw TenantLoginError.From(err)
        }
    }

    /** A fresh random confidential-client secret. */
    private MintSecret(): string
    {
        return randomBytes(TenantOidcRelyingParty.SecretBytes).toString(TenantOidcRelyingParty.SecretEncoding)
    }

    /** Non-durable path: a brand-new secret, seeded into the in-memory store, on every login (legacy behaviour). */
    private async FreshSecretForLogin(secretRef: string): Promise<string>
    {
        const stores = await this.stores()
        const secret = this.MintSecret()
        await stores.Secrets.Put(secretRef, secret)
        return secret
    }

    /** Durable path: reuse the stored secret until it ages past the TTL, coalescing concurrent calls per tenant. */
    private SecretForLogin(tenantId: string, secretRef: string): Promise<string>
    {
        const pending = this.inFlight.get(tenantId)
        if (pending !== undefined)
        {
            return pending
        }
        const minted = this.MintOrReuse(tenantId, secretRef).finally(() => this.inFlight.delete(tenantId))
        this.inFlight.set(tenantId, minted)
        return minted
    }

    private async MintOrReuse(tenantId: string, secretRef: string): Promise<string>
    {
        const durability = this.durability!
        const now = durability.now ?? (() => Date.now())
        const stores = await this.stores()
        const record = durability.registry.Get(tenantId)
        const existing = await stores.Secrets.Get(secretRef)
        // A corrupted/unparseable rotatedAt counts as aged, so a bad row forces a rotation rather than freezing the secret forever.
        const parsed = record === undefined ? Number.NaN : Date.parse(record.rotatedAt)
        const aged = record !== undefined && (Number.isNaN(parsed) || (now() - parsed) > durability.secretTtlMs)
        if (record === undefined || existing === null || aged)
        {
            const secret = this.MintSecret()
            await stores.Secrets.Put(secretRef, secret)
            await durability.registry.Put({ id: tenantId, tenantId, clientId: TenantOidcRelyingParty.AdminClientId, secretRef, rotatedAt: new Date(now()).toISOString() })
            return secret
        }
        return existing
    }

    public async Complete(tenantId: string, code: string, state: string, callbackUrl?: string): Promise<{ principalId: string; email?: string }>
    {
        const presented = new PresentedSecret(code)
        try
        {
            const cb = callbackUrl ?? this.callbackUrl
            const conn = await this.idp.EnsureForTenant(tenantId, this.displayNameFor(tenantId))
            const secretRef = TenantOidcRelyingParty.SecretRefPrefix + tenantId
            const stores = await this.stores()
            const tenant = this.tenantFor(tenantId)
            const resolved = this.resolverFor(conn).Resolve(tenant, this.configFor(conn, tenantId, secretRef, cb), stores)
            const authenticator = resolved.Oidc?.AuthenticatorFor(AuthMethod.Oidc)
            if (authenticator === undefined)
            {
                throw new TenantLoginError()
            }
            const result = await authenticator.Authenticate(new Credential(AuthMethod.Oidc, state), presented, tenant)
            if (!(result instanceof AuthenticatedResult))
            {
                throw new TenantLoginError()
            }
            const email = result.Principal.Claim(TenantOidcRelyingParty.EmailClaim)
            return email === undefined ? { principalId: result.Principal.Id } : { principalId: result.Principal.Id, email }
        }
        catch (err)
        {
            throw TenantLoginError.From(err)
        }
        finally
        {
            presented.Clear()
        }
    }

    private displayNameFor(tenantId: string): string
    {
        return this.directory.GetTenant(tenantId)?.displayName ?? tenantId
    }

    private tenantFor(tenantId: string): Tenant
    {
        return new Tenant(tenantId, TenantKind.Saas, this.displayNameFor(tenantId))
    }

    private resolverFor(conn: IdpConnection): IdentityPackResolver
    {
        return this.resolverOverride ?? new IdentityPackResolver(new CaTrustingHttpClient(conn.ca), this.flowStates)
    }

    private configFor(conn: IdpConnection, tenantId: string, secretRef: string, callbackUrl: string): IdentityConfig
    {
        const issuer = conn.baseUrl + TenantOidcRelyingParty.IssuerSeparator + encodeURIComponent(tenantId)
        const providerSettings = new Map<string, string>([
            [OidcSettingKeys.Issuer, issuer],
            [OidcSettingKeys.DiscoveryUrl, issuer + TenantOidcRelyingParty.WellKnownSuffix],
            [OidcSettingKeys.ClientId, TenantOidcRelyingParty.AdminClientId],
            [OidcSettingKeys.RedirectUri, callbackUrl],
            [OidcSettingKeys.SecretRef, secretRef],
        ])
        const claimsMapping = new Map<string, string>([[TenantOidcRelyingParty.EmailClaim, TenantOidcRelyingParty.EmailClaim]])
        return new IdentityConfig(TenantOidcRelyingParty.GenericOidcPackId, DelegationDepth.AuthnDirectory, providerSettings, new Map(), claimsMapping)
    }

    private stores(): Promise<IdentityStoreSet>
    {
        if (this.storesPromise === undefined)
        {
            if (this.durability !== undefined)
            {
                mkdirSync(this.durability.storeRoot, { recursive: true, mode: TenantOidcRelyingParty.SecretDirMode })
                this.storesPromise = FileIdentityStores.Open(new NodeFsStorage(this.durability.storeRoot), this.durability.masterKey)
            }
            else
            {
                this.storesPromise = FileIdentityStores.Open(new FakeStorage(), randomBytes(TenantOidcRelyingParty.MasterKeyBytes))
            }
        }
        return this.storesPromise
    }
}
