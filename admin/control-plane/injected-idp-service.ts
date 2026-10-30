import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
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
    /** Base domain of the in-cluster browser hosts, when the pod knows it. */
    baseDomain?: string
}

/**
 * Connection-only IdP service for the tenant-admin pod: the operator provisioned the IdP, so this never applies or
 * seeds anything. The CA and admin token are read from Secret-mounted files and never appear in errors or logs.
 */
export class InjectedIdpService implements IIdpService
{
    private static readonly Utf8 = 'utf8'
    private static readonly ReadFailed = 'InjectedIdpService: cannot read mounted IdP material file for '
    private static readonly MissingVar = 'InjectedIdpService: a browser base is set but this env var is missing: '
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
        // Fail fast while the browser base is present but a companion var is missing, naming the offending
        // var — otherwise the omission would only surface at first login as a generic read error.
        const caFile = InjectedIdpService.Require(env, TenantAdminEnv.IdpCaFile)
        const adminTokenFile = InjectedIdpService.Require(env, TenantAdminEnv.IdpAdminTokenFile)
        return new InjectedIdpService({
            browserBaseUrl: browser,
            baseUrl: env[TenantAdminEnv.IdpBaseUrl] ?? browser,
            caFile,
            adminTokenFile,
            baseDomain: env[TenantAdminEnv.BaseDomain],
        })
    }

    private static Require(env: NodeJS.ProcessEnv, name: string): string
    {
        const value = env[name]
        if (value === undefined || value === InjectedIdpService.EmptyRef)
        {
            throw new Error(InjectedIdpService.MissingVar + name)
        }
        return value
    }

    public async TeardownForTenant(_tenantId: string): Promise<void>
    {
    }

    public EnsureForTenant(_tenantId: string, _displayName: string): Promise<IdpConnection>
    {
        try
        {
            return Promise.resolve({
                baseUrl: this.config.baseUrl,
                browserBaseUrl: this.config.browserBaseUrl,
                ca: this.ReadFile(this.config.caFile, TenantAdminEnv.IdpCaFile),
                adminToken: this.ReadFile(this.config.adminTokenFile, TenantAdminEnv.IdpAdminTokenFile).toString(InjectedIdpService.Utf8).trim(),
                // Give the fields other IdpConnection consumers read (env Federate's caHostPath, the persisted
                // tenant record's idp refs) real values derived from the mounted paths, not empty strings.
                adminTokenRef: basename(this.config.adminTokenFile),
                caDir: dirname(this.config.caFile),
                baseDomain: this.config.baseDomain,
            })
        }
        catch (err)
        {
            return Promise.reject(err)
        }
    }

    private ReadFile(path: string, varName: string): Buffer
    {
        try
        {
            return readFileSync(path)
        }
        catch
        {
            // Name the env var, never the path content or the fs error (which could echo a secret path).
            throw new Error(InjectedIdpService.ReadFailed + varName)
        }
    }
}
