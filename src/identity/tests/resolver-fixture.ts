import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DelegationDepth, IdentityConfig, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import type { IdentityStoreSet, Role } from '@pragmatic-tech-ai/todl-identity'
import { FakeOidcHttpClient, FakeOidcIdp, InMemoryOidcFlowStateStore, OidcSettingKeys } from '@pragmatic-tech-ai/todl-identity-cloud'
import { NodePlatform } from '../../platform/node-platform.js'
import { IdentityPackResolver } from '../identity-pack-resolver.js'

export class ResolverFixture
{
    public static readonly EntraTenantId = 'test-tid'
    public static readonly GoogleIssuer = 'https://accounts.google.com'
    public static readonly ClientId = 'client-1'
    public static readonly RedirectUri = 'https://app.test/cb'
    public static readonly Subject = 'u1'
    public static readonly Email = 'a@x.io'
    public static readonly Group = 'group-ed'
    public static readonly AuthCode = 'auth-code'
    public static readonly BearerType = 'Bearer'
    private static readonly TempPrefix = 'ps7-'
    private static readonly TenantIdPrefix = 't-'
    private static readonly DiscoveryPath = '/.well-known/openid-configuration'

    private roots: string[] = []

    public async Stores(): Promise<IdentityStoreSet>
    {
        const root = mkdtempSync(join(tmpdir(), ResolverFixture.TempPrefix))
        this.roots.push(root)
        return new NodePlatform().CreateIdentityStores(root, randomBytes(32))
    }

    public Dispose(): void
    {
        for (const root of this.roots)
        {
            rmSync(root, { recursive: true, force: true })
        }
        this.roots = []
    }

    public EntraSettings(): Map<string, string>
    {
        return new Map([
            [OidcSettingKeys.AadTenantId, ResolverFixture.EntraTenantId],
            [OidcSettingKeys.ClientId, ResolverFixture.ClientId],
            [OidcSettingKeys.RedirectUri, ResolverFixture.RedirectUri],
        ])
    }

    public GoogleSettings(): Map<string, string>
    {
        return new Map([
            [OidcSettingKeys.Issuer, ResolverFixture.GoogleIssuer],
            [OidcSettingKeys.DiscoveryUrl, ResolverFixture.GoogleIssuer + ResolverFixture.DiscoveryPath],
            [OidcSettingKeys.ClientId, ResolverFixture.ClientId],
            [OidcSettingKeys.RedirectUri, ResolverFixture.RedirectUri],
        ])
    }

    /** Resolve a pack for one tenant, run begin, mint a matching id_token, and arm the token endpoint. */
    public async Flow(packId: string, issuer: string, settings: Map<string, string>, depth: DelegationDepth, groupRoleMap: ReadonlyMap<string, Role>, groupsClaim: string)
    {
        const idp = await FakeOidcIdp.Create(issuer)
        const http = new FakeOidcHttpClient(idp)
        const flowStates = new InMemoryOidcFlowStateStore()
        const stores = await this.Stores()
        const config = new IdentityConfig(packId, depth, settings, groupRoleMap, new Map())
        const tenant = new Tenant(ResolverFixture.TenantIdPrefix + packId, TenantKind.Saas, packId)
        const resolver = new IdentityPackResolver(http, flowStates)
        const resolved = resolver.Resolve(tenant, config, stores)
        const begun = await resolved.Oidc!.BeginAuthorization(tenant)
        const nonce = flowStates.Peek(begun.State)!.Nonce
        const idToken = await idp.MintIdToken({
            sub: ResolverFixture.Subject,
            aud: ResolverFixture.ClientId,
            nonce,
            email: ResolverFixture.Email,
            [groupsClaim]: [ResolverFixture.Group],
        })
        http.NextTokenResponse = { id_token: idToken, token_type: ResolverFixture.BearerType }
        return { resolved, tenant, State: begun.State, idToken, http, flowStates }
    }
}
