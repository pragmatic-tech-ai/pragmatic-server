import type { ClientRegistry } from './client-registry.js'
import type { TenantRegistry } from './tenant-registry.js'
import type { HiveRegistry } from './hive-registry.js'
import type { EnvironmentRecord } from './environment-record.js'
import { HivePlacementError } from './hive-placement-error.js'
import { RecordId } from './platform-records.js'
import type { ClientRecord, TenantRecord, HiveRecord, ClusterSpec, RegistrySpec } from './platform-records.js'

export interface IEnvironmentLookup
{
    List(): readonly EnvironmentRecord[]
}

export class RecordExistsError extends Error
{
    private static readonly ErrorName = 'RecordExistsError'
    private static readonly MessagePrefix = 'Record already exists: '

    public constructor(id: string)
    {
        super(RecordExistsError.MessagePrefix + id)
        this.name = RecordExistsError.ErrorName
    }
}

export class UnknownClientError extends Error
{
    private static readonly ErrorName = 'UnknownClientError'
    private static readonly MessagePrefix = 'Unknown client: '

    public constructor(id: string)
    {
        super(UnknownClientError.MessagePrefix + id)
        this.name = UnknownClientError.ErrorName
    }
}

export class UnknownTenantError extends Error
{
    private static readonly ErrorName = 'UnknownTenantError'
    private static readonly MessagePrefix = 'Unknown tenant: '

    public constructor(id: string)
    {
        super(UnknownTenantError.MessagePrefix + id)
        this.name = UnknownTenantError.ErrorName
    }
}

export class ClientHasTenantsError extends Error
{
    private static readonly ErrorName = 'ClientHasTenantsError'
    private static readonly MessagePrefix = 'Client still has tenants: '

    public constructor(id: string)
    {
        super(ClientHasTenantsError.MessagePrefix + id)
        this.name = ClientHasTenantsError.ErrorName
    }
}

export class TenantHasHivesError extends Error
{
    private static readonly ErrorName = 'TenantHasHivesError'
    private static readonly MessagePrefix = 'Tenant still has hives: '

    public constructor(id: string)
    {
        super(TenantHasHivesError.MessagePrefix + id)
        this.name = TenantHasHivesError.ErrorName
    }
}

export class HiveHasEnvironmentsError extends Error
{
    private static readonly ErrorName = 'HiveHasEnvironmentsError'
    private static readonly MessagePrefix = 'Hive still has environments: '

    public constructor(id: string)
    {
        super(HiveHasEnvironmentsError.MessagePrefix + id)
        this.name = HiveHasEnvironmentsError.ErrorName
    }
}

export class PlatformDirectory
{
    public constructor(
        private readonly clients: ClientRegistry,
        private readonly tenants: TenantRegistry,
        private readonly hives: HiveRegistry,
        private readonly environments: IEnvironmentLookup,
        private readonly now: () => Date = () => new Date())
    {
    }

    public async Load(): Promise<void>
    {
        await this.clients.Load()
        await this.tenants.Load()
        await this.hives.Load()
    }

    public ListClients(): readonly ClientRecord[]
    {
        return this.clients.List()
    }

    public GetClient(id: string): ClientRecord | undefined
    {
        return this.clients.Get(id)
    }

    public async CreateClient(input: { id: string; displayName: string; subscriptionRef?: string }): Promise<ClientRecord>
    {
        this.AssertNew(input.id, this.clients.Get(input.id))
        const record: ClientRecord = { id: input.id, displayName: input.displayName, subscriptionRef: input.subscriptionRef, createdAt: this.Stamp() }
        await this.clients.Put(record)
        return record
    }

    public async DeleteClient(id: string): Promise<void>
    {
        if (this.tenants.List().some(t => t.clientId === id))
        {
            throw new ClientHasTenantsError(id)
        }
        await this.clients.Remove(id)
    }

    public ListTenants(clientId?: string): readonly TenantRecord[]
    {
        const all = this.tenants.List()
        return clientId === undefined ? all : all.filter(t => t.clientId === clientId)
    }

    public GetTenant(id: string): TenantRecord | undefined
    {
        return this.tenants.Get(id)
    }

    public async CreateTenant(input: { id: string; clientId: string; displayName: string }): Promise<TenantRecord>
    {
        this.AssertNew(input.id, this.tenants.Get(input.id))
        if (this.clients.Get(input.clientId) === undefined)
        {
            throw new UnknownClientError(input.clientId)
        }
        const record: TenantRecord = { id: input.id, clientId: input.clientId, displayName: input.displayName, createdAt: this.Stamp() }
        await this.tenants.Put(record)
        return record
    }

    public async CreateProvisionedTenant(input: { id: string; clientId: string; displayName: string; ownerEmail: string; ownerPrincipalId: string; idpBaseUrl: string; idpCaRef?: string; idpAdminTokenRef?: string }): Promise<TenantRecord>
    {
        this.AssertCanCreateTenant(input.id, input.clientId)
        const record: TenantRecord = {
            id: input.id,
            clientId: input.clientId,
            displayName: input.displayName,
            createdAt: this.Stamp(),
            ownerEmail: input.ownerEmail,
            ownerPrincipalId: input.ownerPrincipalId,
            idpBaseUrl: input.idpBaseUrl,
            idpCaRef: input.idpCaRef,
            idpAdminTokenRef: input.idpAdminTokenRef
        }
        await this.tenants.Put(record)
        return record
    }

    /** Read-only pre-flight: throws RecordExistsError for a duplicate id and UnknownClientError for a missing parent client. */
    public AssertCanCreateTenant(id: string, clientId: string): void
    {
        this.AssertNew(id, this.tenants.Get(id))
        if (this.clients.Get(clientId) === undefined)
        {
            throw new UnknownClientError(clientId)
        }
    }

    public async DeleteTenant(id: string): Promise<void>
    {
        if (this.hives.List().some(h => h.tenantId === id))
        {
            throw new TenantHasHivesError(id)
        }
        await this.tenants.Remove(id)
    }

    public ListHives(tenantId?: string): readonly HiveRecord[]
    {
        const all = this.hives.List()
        return tenantId === undefined ? all : all.filter(h => h.tenantId === tenantId)
    }

    public GetHive(id: string): HiveRecord | undefined
    {
        return this.hives.Get(id)
    }

    public async CreateHive(input: { id: string; tenantId: string; displayName: string; cluster: ClusterSpec; registry: RegistrySpec; trustRootRef?: string }): Promise<HiveRecord>
    {
        this.AssertNew(input.id, this.hives.Get(input.id))
        if (this.tenants.Get(input.tenantId) === undefined)
        {
            throw new UnknownTenantError(input.tenantId)
        }
        const record: HiveRecord = {
            id: input.id,
            tenantId: input.tenantId,
            displayName: input.displayName,
            cluster: input.cluster,
            registry: input.registry,
            trustRootRef: input.trustRootRef,
            createdAt: this.Stamp()
        }
        await this.hives.Put(record)
        return record
    }

    public async DeleteHive(id: string): Promise<void>
    {
        if (this.environments.List().some(e => e.hiveId === id))
        {
            throw new HiveHasEnvironmentsError(id)
        }
        await this.hives.Remove(id)
    }

    public ValidateHivePlacement(tenantId: string, hiveId: string): void
    {
        const hive = this.hives.Get(hiveId)
        HivePlacementError.Assert(hive, tenantId, hiveId)
    }

    private AssertNew(id: string, existing: unknown): void
    {
        RecordId.Validate(id)
        if (existing !== undefined)
        {
            throw new RecordExistsError(id)
        }
    }

    private Stamp(): string
    {
        return this.now().toISOString()
    }
}
