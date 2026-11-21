import type { IStorage, IPromptService } from '@pragmatic-tech-ai/todl-runtime'
import type { ISqlSession, IStorageProviderRegistry } from '@pragmatic-tech-ai/todl'
import type { IdentityStoreSet, ISecretStore, IRealmConfigStore, IAuditSink } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlLocalAccountStore, SqlServiceTokenStore, SqlSessionStore, SqlRoleGrantStore, SqlAuditStore, SqlAuditCheckpointStore, SqlRealmConfigStore, SqlIdpDirectoryStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { AuditAnchor, AuditAnchoring, HmacAuditCheckpointSigner } from '@pragmatic-tech-ai/pragmatic-identity-realm'
import { FileEncryptedSecretStore } from '@pragmatic-tech-ai/pragmatic-identity-store'
import { HeadlessPromptService } from '@pragmatic-tech-ai/pragmatic-realm-custom'
import type { PlatformServices } from './platform-services.js'
import type { MasterKeyRef } from '@pragmatic-tech-ai/pragmatic-env-cluster'

/** The five multi-realm SQL identity stores opened once and shared across realms (Secrets is per-realm,
 *  composed separately in CreateIdentityStores). */
interface SqlIdentityStores
{
    readonly Accounts: SqlLocalAccountStore
    readonly Tokens: SqlServiceTokenStore
    readonly Sessions: SqlSessionStore
    readonly Grants: SqlRoleGrantStore
    readonly Audit: SqlAuditStore
    readonly IdpDirectory: SqlIdpDirectoryStore
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
 *  (over ONE shared ISqlSession) + FileEncryptedSecretStore-over-object-storage for per-realm pack secrets.
 *  The SQL stores are multi-realm by data (every row/method carries the realm), so they are opened ONCE and
 *  shared across realms; each Open runs its store's schema migrations (SqlMigrationRunner). Per
 *  CreateIdentityStores call, a fresh per-realm Secrets store is composed over a per-realm object-store
 *  namespace, isolating secrets by location. The master key is resolved ONCE from the secret manager by
 *  reference at Create and held; ResolveMasterKey hands out a defensive copy. */
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
    private environmentConfigPromise: Promise<IRealmConfigStore> | undefined

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
            if (resolved === null || resolved.length === 0)
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

    public CreateStorage(root: string): IStorage
    {
        return this.storage.CreateStorage(root)
    }

    public CreatePackagesStorage(packagesRoot: string): IStorage
    {
        return this.CreateStorage(packagesRoot)
    }

    public CreatePromptService(): IPromptService
    {
        return this.prompt
    }

    /** The shared multi-realm SQL audit store, for the access-audit bridge in cloud composition. */
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
        return { Secrets: secrets, Accounts: sql.Accounts, Tokens: sql.Tokens, Sessions: sql.Sessions, Grants: sql.Grants, Audit: sql.Audit, IdpDirectory: sql.IdpDirectory }
    }

    public CreateRealmConfigStore(_configRoot: string): Promise<IRealmConfigStore>
    {
        return this.realmConfigStore()
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
            IdpDirectory: await SqlIdpDirectoryStore.Open(this.session),
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

    private realmConfigStore(): Promise<IRealmConfigStore>
    {
        if (this.environmentConfigPromise === undefined)
        {
            this.environmentConfigPromise = SqlRealmConfigStore.Open(this.session).catch(e => { this.environmentConfigPromise = undefined; throw e })
        }
        return this.environmentConfigPromise
    }
}
