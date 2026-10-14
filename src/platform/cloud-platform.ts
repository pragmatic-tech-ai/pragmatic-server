import type { IStorage, IPromptService } from '@pragmatic-tech-ai/todl-runtime'
import type { ISqlSession, IStorageProviderRegistry } from '@pragmatic-tech-ai/todl'
import type { IdentityStoreSet, ISecretStore, ITenantConfigStore, IAuditSink } from '@pragmatic-tech-ai/todl-identity'
import { SqlLocalAccountStore, SqlServiceTokenStore, SqlSessionStore, SqlRoleGrantStore, SqlAuditStore, SqlAuditCheckpointStore, SqlTenantConfigStore } from '@pragmatic-tech-ai/todl-platform-cloud'
import { AuditAnchor, AuditAnchoring, HmacAuditCheckpointSigner } from '@pragmatic-tech-ai/todl-identity-host'
import { FileEncryptedSecretStore } from '@pragmatic-tech-ai/todl-identity-node'
import { HeadlessPromptService } from '@pragmatic-tech-ai/todl-platform-node'
import type { PlatformServices } from './platform-services.js'
import type { MasterKeyRef } from '../identity/master-key-resolver.js'

/** The five multi-tenant SQL identity stores opened once and shared across tenants (Secrets is per-tenant,
 *  composed separately in CreateIdentityStores). */
interface SqlIdentityStores
{
    readonly Accounts: SqlLocalAccountStore
    readonly Tokens: SqlServiceTokenStore
    readonly Sessions: SqlSessionStore
    readonly Grants: SqlRoleGrantStore
    readonly Audit: SqlAuditStore
}

export interface CloudPlatformOptions
{
    readonly session: ISqlSession
    readonly storage: IStorageProviderRegistry
    readonly secretManager: ISecretStore
    readonly masterKeyRef: string
    readonly auditAnchorKeyRef?: string
    readonly auditAnchorInterval?: number
}

/** Cloud PlatformServices bundle. Composes the object-store registry + the DB-backed identity stores
 *  (over ONE shared ISqlSession) + FileEncryptedSecretStore-over-object-storage for per-tenant pack secrets.
 *  The SQL stores are multi-tenant by data (every row/method carries the tenant), so they are opened ONCE and
 *  shared across tenants - which also avoids re-running CREATE TABLE on one db (pg-mem rejects a repeated
 *  constrained CREATE TABLE). Per CreateIdentityStores call, a fresh per-tenant Secrets store is composed over
 *  a per-tenant object-store namespace, isolating secrets by location. The master key is resolved ONCE from the
 *  secret manager by reference at Create and held; ResolveMasterKey hands out a defensive copy. */
export class CloudPlatform implements PlatformServices
{
    private static readonly KeyByteLength = 32
    private static readonly MissingKeyMessage = 'cloud master key reference not found'
    private static readonly InvalidKeyMessage = 'cloud master key must be exactly 32 bytes'
    private static readonly MissingAnchorKeyMessage = 'cloud audit anchor key reference not found'
    private static readonly DefaultAnchorInterval = 1

    private readonly session: ISqlSession
    private readonly storage: IStorageProviderRegistry
    private readonly prompt: IPromptService
    private readonly masterKey: Buffer
    private readonly anchorKey: string | undefined
    private readonly anchorInterval: number
    private sqlStoresPromise: Promise<SqlIdentityStores> | undefined
    private tenantConfigPromise: Promise<ITenantConfigStore> | undefined

    private constructor(session: ISqlSession, storage: IStorageProviderRegistry, masterKey: Buffer, anchorKey: string | undefined, anchorInterval: number)
    {
        this.session = session
        this.storage = storage
        this.prompt = new HeadlessPromptService()
        this.masterKey = masterKey
        this.anchorKey = anchorKey
        this.anchorInterval = anchorInterval
    }

    public static async Create(options: CloudPlatformOptions): Promise<CloudPlatform>
    {
        const encoded = await options.secretManager.Get(options.masterKeyRef)
        if (encoded === null)
        {
            throw new Error(CloudPlatform.MissingKeyMessage)
        }
        const key = Buffer.from(encoded, 'base64')
        if (key.length !== CloudPlatform.KeyByteLength)
        {
            throw new Error(CloudPlatform.InvalidKeyMessage)
        }
        let anchorKey: string | undefined
        if (options.auditAnchorKeyRef !== undefined && options.auditAnchorKeyRef.length > 0)
        {
            const resolved = await options.secretManager.Get(options.auditAnchorKeyRef)
            if (resolved === null)
            {
                throw new Error(CloudPlatform.MissingAnchorKeyMessage)
            }
            anchorKey = resolved
        }
        return new CloudPlatform(options.session, options.storage, key, anchorKey, options.auditAnchorInterval ?? CloudPlatform.DefaultAnchorInterval)
    }

    public CreateStorageProviderRegistry(): IStorageProviderRegistry
    {
        return this.storage
    }

    public CreatePackagesStorage(packagesRoot: string): IStorage
    {
        return this.storage.CreateStorage(packagesRoot)
    }

    public CreatePromptService(): IPromptService
    {
        return this.prompt
    }

    /** The shared multi-tenant SQL audit store, for the access-audit bridge in cloud composition. */
    public async AuditSink(): Promise<IAuditSink>
    {
        return (await this.sqlStores()).Audit
    }

    public ResolveMasterKey(_ref: MasterKeyRef): Buffer
    {
        return Buffer.from(this.masterKey)
    }

    public async CreateIdentityStores(identityRoot: string, masterKey: Buffer): Promise<IdentityStoreSet>
    {
        const sql = await this.sqlStores()
        const secrets = await FileEncryptedSecretStore.Open(this.storage.CreateStorage(identityRoot), masterKey)
        return { Secrets: secrets, Accounts: sql.Accounts, Tokens: sql.Tokens, Sessions: sql.Sessions, Grants: sql.Grants, Audit: sql.Audit }
    }

    public CreateTenantConfigStore(_configRoot: string): Promise<ITenantConfigStore>
    {
        return this.tenantConfigStore()
    }

    private sqlStores(): Promise<SqlIdentityStores>
    {
        if (this.sqlStoresPromise === undefined)
        {
            this.sqlStoresPromise = this.OpenSqlStores().catch(e => { this.sqlStoresPromise = undefined; throw e })
        }
        return this.sqlStoresPromise
    }

    private async OpenSqlStores(): Promise<SqlIdentityStores>
    {
        return {
            Accounts: await SqlLocalAccountStore.Open(this.session),
            Tokens: await SqlServiceTokenStore.Open(this.session),
            Sessions: await SqlSessionStore.Open(this.session),
            Grants: await SqlRoleGrantStore.Open(this.session),
            Audit: await this.OpenAudit(),
        }
    }

    private async OpenAudit(): Promise<SqlAuditStore>
    {
        if (this.anchorKey === undefined)
        {
            return SqlAuditStore.Open(this.session)
        }
        const anchoring = new AuditAnchoring(new AuditAnchor(new HmacAuditCheckpointSigner(this.anchorKey), this.anchorInterval), await SqlAuditCheckpointStore.Open(this.session))
        return SqlAuditStore.Open(this.session, anchoring)
    }

    private tenantConfigStore(): Promise<ITenantConfigStore>
    {
        if (this.tenantConfigPromise === undefined)
        {
            this.tenantConfigPromise = SqlTenantConfigStore.Open(this.session).catch(e => { this.tenantConfigPromise = undefined; throw e })
        }
        return this.tenantConfigPromise
    }
}
