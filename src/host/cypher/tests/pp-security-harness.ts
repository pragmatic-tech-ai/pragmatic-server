import { randomBytes } from 'node:crypto'
import { AccessContext, Principal, PrincipalKind, Realm, RealmKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy, IdentityConfig } from '@pragmatic-tech-ai/pragmatic-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/pragmatic-identity'
import type { PragmaticServer } from '../../../pragmatic-server.js'

export class PpSecurityHarness
{
    public static readonly KeyEnv = 'PS_SP3B_KEY'
    public static readonly EnvironmentId = 't1'
    public static readonly Concept = 'Widget'
    public static readonly OwningBuField = 'owningBu'
    public static readonly SalesBu = 'sales'
    public static readonly RootBu = 'root'
    private static readonly EnvironmentName = 'Environment One'
    private static readonly NotSeededError = 'realm config was not seeded on boot'

    public static SetKey(): void
    {
        process.env[PpSecurityHarness.KeyEnv] = randomBytes(32).toString('base64')
    }

    public static ClearKey(): void
    {
        delete process.env[PpSecurityHarness.KeyEnv]
    }

    public static Identity(identityRoot: string)
    {
        return {
            identityRoot,
            masterKey: { base64Env: PpSecurityHarness.KeyEnv },
            environment: { id: PpSecurityHarness.EnvironmentId, displayName: PpSecurityHarness.EnvironmentName },
        }
    }

    public static Context(principalId: string): AccessContext
    {
        const realm = new Realm(PpSecurityHarness.EnvironmentId, RealmKind.SelfHosted, PpSecurityHarness.EnvironmentName)
        const principal = new Principal(principalId, PpSecurityHarness.EnvironmentId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(principalId, Role.Owner, new ResourceRef(ResourceKind.Realm, PpSecurityHarness.EnvironmentId, []))]
        return new AccessContext(principal, realm, grants, new ResourceAuthorizationPolicy())
    }

    public static async Seed(server: PragmaticServer, model: ISecurityModelConfig): Promise<void>
    {
        const store = await server.RealmConfigStore()
        const seeded = await store.Get(PpSecurityHarness.EnvironmentId)
        if (seeded === null)
        {
            throw new Error(PpSecurityHarness.NotSeededError)
        }
        const merged = new IdentityConfig(seeded.PackId, seeded.DelegationDepth, seeded.ProviderSettings, seeded.GroupRoleMap, seeded.ClaimsMapping, model)
        await store.Save(PpSecurityHarness.EnvironmentId, merged)
    }
}
