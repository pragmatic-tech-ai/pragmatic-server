import { Role, ResourceRef, ResourceKind, PresentedSecret } from '@pragmatic-tech-ai/todl-identity'
import type { AdminService } from '../host/admin-service.js'
import { DeploymentMode } from '../platform/deployment-mode.js'

/** Seeding helpers for the runtime-tenant principals the RBAC proof needs, plus the default local dev account. */
export class RuntimePrincipals
{
    /**
     * Coarse role for the read-only reader. The dispatch gate maps data/write to Action.Write on the Tenant, and
     * the coarse taxonomy has exactly one role that confers Write without Administer: Editor (Admin and Owner
     * both add Administer). Editor lets the reader REACH the data/write handler without over-granting
     * administration, so the write is denied by the fine per-concept security-model role (read-only, applied
     * through the config path), not by the coarse dispatch gate.
     */
    private static readonly ReaderCoarseRole = Role.Editor

    /** Coarse role for the default dev account: a local-only maker who must author, publish and administer. */
    private static readonly DevCoarseRole = Role.Owner

    private static readonly DevPrincipalId = 'dev'
    private static readonly DevEmail = 'dev@localhost'
    /** Well-known local-development credential; never used for a non-dev deployment. */
    private static readonly DevPassword = 'dev'

    /** Environment key the server reads its deployment mode from (see ServerConfigLoader); unset means local. */
    private static readonly DeploymentModeEnvKey = 'PRAGMATIC_DEPLOYMENT_MODE'
    private static readonly NotLocalMode = 'SeedDevAccount refused: the dev/dev account may only be seeded when PRAGMATIC_DEPLOYMENT_MODE is local'

    /** Creates the reader account and gives it only the coarse capability; per-concept roles come from the security model. */
    public static async SeedReader(admin: AdminService, actor: string, email: string, principalId: string, password: PresentedSecret): Promise<void>
    {
        const account = await admin.CreateAccount(actor, email, principalId, password)
        await admin.GrantRole(actor, principalId, RuntimePrincipals.ReaderCoarseRole, new ResourceRef(ResourceKind.Tenant, account.TenantId, []))
    }

    /** Seeds the default local dev account; throws unless the deployment mode is local; a no-op when it already exists. */
    public static async SeedDevAccount(admin: AdminService, actor: string): Promise<void>
    {
        const mode = process.env[RuntimePrincipals.DeploymentModeEnvKey]
        if (mode !== undefined && mode !== DeploymentMode.Local)
        {
            throw new Error(RuntimePrincipals.NotLocalMode)
        }
        const existing = await admin.ListAccounts()
        if (existing.some(a => a.PrincipalId === RuntimePrincipals.DevPrincipalId))
        {
            return
        }
        const account = await admin.CreateAccount(actor, RuntimePrincipals.DevEmail, RuntimePrincipals.DevPrincipalId, new PresentedSecret(RuntimePrincipals.DevPassword))
        await admin.GrantRole(actor, RuntimePrincipals.DevPrincipalId, RuntimePrincipals.DevCoarseRole, new ResourceRef(ResourceKind.Tenant, account.TenantId, []))
    }
}
