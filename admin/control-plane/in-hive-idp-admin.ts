import type { IInstallOrchestratorSource } from './hive-agent-installer.js'
import { IdpAdminClient } from './idp-admin-client.js'
import type { IdpConnection } from './idp-workload-driver.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KubectlCli, NodeProcessSpawner, type IProcessSpawner } from './kubectl.js'
import type { HiveRecord, TenantRecord } from './platform-records.js'
import type { SealedSecretStore } from './sealed-secret-store.js'
import { OwnerNotRecordedError, OwnerResetInProgressError, TenantProvisioningService } from './tenant-provisioning-service.js'

/** A fresh in-hive Owner password, returned once to the operator (never logged, audited or stored). */
export type InHiveOwnerPassword = { ownerEmail: string; ownerPassword: string }

/** The control plane cannot reach the in-hive IdP's admin API (no stored credentials, or no tunnel-capable kubectl). Maps to 409. */
export class InHiveIdpUnavailableError extends Error
{
    public static readonly NoCredentialsMessage = 'This control plane holds no credentials for the in-hive identity provider. Install the console first.'
    public static readonly NoTunnelMessage = "This control plane cannot open a tunnel to the hive's identity provider: its cluster is not reached through a kubectl context."
    private static readonly ErrorName = 'InHiveIdpUnavailableError'

    public constructor(message: string = InHiveIdpUnavailableError.NoCredentialsMessage)
    {
        super(message)
        this.name = InHiveIdpUnavailableError.ErrorName
    }
}

/** The control plane's admin hand on a hive's in-cluster IdP: keeps its CA + admin token sealed, and talks to it over a loopback tunnel. */
export interface IInHiveIdpAdmin
{
    /** Seals the IdP's CA certificate and admin token for later admin calls. */
    Remember(tenantId: string, ca: Buffer, adminToken: string): Promise<void>
    /** Ensures the tenant's realm and its recorded Owner account (an existing account keeps its password). */
    SeedOwner(hive: HiveRecord, tenant: TenantRecord): Promise<void>
    /** Sets a fresh Owner password and returns it once. */
    ResetOwnerPassword(hive: HiveRecord, tenant: TenantRecord): Promise<InHiveOwnerPassword>
    /** Drops the sealed credentials (hive delete). */
    Forget(tenantId: string): Promise<void>
}

/**
 * Reaches the in-hive IdP's `/_admin/` API through `kubectl port-forward svc/<idp> 9443` on the hive's own kubectl context (the IdP
 * certificate carries the IP SAN 127.0.0.1), with the CA and admin token sealed in the control plane's store. The tunnel is closed
 * after every call, failed or not. Credentials and passwords never appear in errors or logs.
 */
export class InHiveIdpAdmin implements IInHiveIdpAdmin
{
    private static readonly CaRefPrefix = 'in-hive-idp-ca/'
    private static readonly TokenRefPrefix = 'in-hive-idp-admin-token/'
    private static readonly IdpPort = 9443
    private static readonly ServicePrefix = 'svc/'
    private static readonly LoopbackPrefix = 'https://127.0.0.1:'
    private static readonly Utf8 = 'utf8'

    /** Tenants with an in-hive Owner password reset in flight (one at a time per tenant). */
    private readonly resetting = new Set<string>()

    public constructor(
        private readonly orchestrators: IInstallOrchestratorSource,
        private readonly store: SealedSecretStore,
        private readonly spawner: IProcessSpawner = new NodeProcessSpawner(),
        private readonly adminClients: (conn: IdpConnection) => IdpAdminClient = conn => new IdpAdminClient(conn))
    {
    }

    public static CaRefOf(tenantId: string): string
    {
        return `${InHiveIdpAdmin.CaRefPrefix}${tenantId}`
    }

    public static TokenRefOf(tenantId: string): string
    {
        return `${InHiveIdpAdmin.TokenRefPrefix}${tenantId}`
    }

    public async Remember(tenantId: string, ca: Buffer, adminToken: string): Promise<void>
    {
        await this.store.Put(InHiveIdpAdmin.CaRefOf(tenantId), ca)
        await this.store.Put(InHiveIdpAdmin.TokenRefOf(tenantId), Buffer.from(adminToken, InHiveIdpAdmin.Utf8))
    }

    public async SeedOwner(hive: HiveRecord, tenant: TenantRecord): Promise<void>
    {
        const ownerEmail = InHiveIdpAdmin.OwnerEmailOf(tenant)
        await this.WithTunnel(hive, tenant.id, async client =>
        {
            await client.EnsureRealm(tenant.id, tenant.displayName)
            // The IdP keeps an existing principal's password, so this generated one only lands on a first seed and is discarded:
            // the operator sets a known one with ResetOwnerPassword.
            await client.SeedAccount(tenant.id, {
                email: ownerEmail,
                principalId: InHiveIdpAdmin.OwnerPrincipalOf(tenant),
                displayName: tenant.displayName,
                password: TenantProvisioningService.NewOwnerPassword(),
            })
        })
    }

    public async ResetOwnerPassword(hive: HiveRecord, tenant: TenantRecord): Promise<InHiveOwnerPassword>
    {
        const ownerEmail = InHiveIdpAdmin.OwnerEmailOf(tenant)
        if (this.resetting.has(tenant.id))
        {
            throw new OwnerResetInProgressError()
        }
        this.resetting.add(tenant.id)
        try
        {
            const ownerPassword = TenantProvisioningService.NewOwnerPassword()
            await this.WithTunnel(hive, tenant.id, async client =>
            {
                try
                {
                    await client.ResetPassword(tenant.id, InHiveIdpAdmin.OwnerPrincipalOf(tenant), ownerPassword)
                }
                catch (err)
                {
                    throw TenantProvisioningService.ResetFailure(err)
                }
            })
            return { ownerEmail, ownerPassword }
        }
        finally
        {
            this.resetting.delete(tenant.id)
        }
    }

    public async Forget(tenantId: string): Promise<void>
    {
        await this.store.Delete(InHiveIdpAdmin.CaRefOf(tenantId))
        await this.store.Delete(InHiveIdpAdmin.TokenRefOf(tenantId))
    }

    /** Opens the loopback tunnel to the tenant's IdP Service, runs `op` with an admin client over it, and always closes the tunnel. */
    private async WithTunnel(hive: HiveRecord, tenantId: string, op: (client: IdpAdminClient) => Promise<void>): Promise<void>
    {
        const ca = await this.store.Get(InHiveIdpAdmin.CaRefOf(tenantId))
        const token = await this.store.Get(InHiveIdpAdmin.TokenRefOf(tenantId))
        if (ca === undefined || token === undefined)
        {
            throw new InHiveIdpUnavailableError()
        }
        const kubectl = this.orchestrators.For(hive).Kubectl
        if (!KubectlCli.CanPortForward(kubectl))
        {
            throw new InHiveIdpUnavailableError(InHiveIdpUnavailableError.NoTunnelMessage)
        }
        const idp = K8sManifestBuilder.IdpNameOf(tenantId)
        const tunnel = await kubectl.PortForward(idp, InHiveIdpAdmin.ServicePrefix + idp, InHiveIdpAdmin.IdpPort, this.spawner)
        try
        {
            const baseUrl = InHiveIdpAdmin.LoopbackPrefix + String(tunnel.LocalPort)
            const conn: IdpConnection = {
                baseUrl,
                browserBaseUrl: baseUrl,
                ca,
                adminToken: token.toString(InHiveIdpAdmin.Utf8),
                adminTokenRef: InHiveIdpAdmin.TokenRefOf(tenantId),
                caDir: '',
            }
            await op(this.adminClients(conn))
        }
        finally
        {
            tunnel.Process.Kill()
        }
    }

    private static OwnerEmailOf(tenant: TenantRecord): string
    {
        if (tenant.ownerEmail === undefined)
        {
            throw new OwnerNotRecordedError()
        }
        return tenant.ownerEmail
    }

    private static OwnerPrincipalOf(tenant: TenantRecord): string
    {
        return tenant.ownerPrincipalId ?? TenantProvisioningService.OwnerPrincipalId
    }
}
