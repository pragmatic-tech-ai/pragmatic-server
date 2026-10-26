import { readFileSync } from 'node:fs'
import { TenantAdminEnv } from './tenant-admin-env.js'
import type { IdpConnection } from './idp-workload-driver.js'
import type { IIdpService } from './idp-service.js'

export interface InjectedIdpConfig
{
    /** Origin a browser reaches the IdP on (issuer + authorize). */
    browserBaseUrl: string
    /** In-cluster Service-DNS origin used for token / jwks / admin calls. */
    baseUrl: string
    /** Path of the mounted CA certificate (public cert only; the CA private key is never shipped). */
    caFile: string
    /** Path of the mounted admin-token Secret file. */
    adminTokenFile: string
}

/**
 * Connection-only IdP service for the tenant-admin pod: the operator provisioned the IdP, so this never applies or
 * seeds anything. The CA and admin token are read from Secret-mounted files and never appear in errors or logs.
 */
export class InjectedIdpService implements IIdpService
{
    private static readonly Utf8 = 'utf8'
    private static readonly ReadFailed = 'InjectedIdpService: cannot read mounted IdP material file'
    private static readonly EmptyRef = ''

    public constructor(private readonly config: InjectedIdpConfig)
    {
    }

    /** Builds the service from the PRAGMATIC_IDP_* env, or undefined when no injected IdP is configured. */
    public static FromEnv(env: NodeJS.ProcessEnv): InjectedIdpService | undefined
    {
        const browser = env[TenantAdminEnv.IdpBrowserBaseUrl]
        if (browser === undefined || browser === InjectedIdpService.EmptyRef)
        {
            return undefined
        }
        return new InjectedIdpService({
            browserBaseUrl: browser,
            baseUrl: env[TenantAdminEnv.IdpBaseUrl] ?? browser,
            caFile: env[TenantAdminEnv.IdpCaFile] ?? InjectedIdpService.EmptyRef,
            adminTokenFile: env[TenantAdminEnv.IdpAdminTokenFile] ?? InjectedIdpService.EmptyRef,
        })
    }

    public EnsureForTenant(_tenantId: string, _displayName: string): Promise<IdpConnection>
    {
        try
        {
            return Promise.resolve({
                baseUrl: this.config.baseUrl,
                browserBaseUrl: this.config.browserBaseUrl,
                ca: this.ReadFile(this.config.caFile),
                adminToken: this.ReadFile(this.config.adminTokenFile).toString(InjectedIdpService.Utf8).trim(),
                adminTokenRef: InjectedIdpService.EmptyRef,
                caDir: InjectedIdpService.EmptyRef,
            })
        }
        catch (err)
        {
            return Promise.reject(err)
        }
    }

    private ReadFile(path: string): Buffer
    {
        try
        {
            return readFileSync(path)
        }
        catch
        {
            throw new Error(InjectedIdpService.ReadFailed)
        }
    }
}
