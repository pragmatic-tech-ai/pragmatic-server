import { RecordId } from './platform-records.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import type { ClientRecord, ClusterSpec, HiveRecord, RegistrySpec, TenantRecord } from './platform-records.js'
import { RecordExistsError, RecordKind, TenantClientMismatchError, UnknownClientError, UnknownTenantError } from './platform-directory.js'
import type { PlatformDirectory } from './platform-directory.js'
import type { TenantProvisioningService } from './tenant-provisioning-service.js'
import type { PlatformDeploymentRegistry } from './platform-deployment-registry.js'

// A reference to a record that already exists: provisioning uses it as is.
export type ExistingRecordRef = { existing: true; id: string }

export type NewClientInput = { existing?: false; id: string; displayName: string; subscriptionRef?: string }
export type NewTenantInput = { existing?: false; id: string; displayName: string; ownerEmail: string }

// The client and the tenant are each either created or an existing record;
// an existing tenant needs an existing client it belongs to. The hive is always new.
export type ProvisionInput = {
    client: NewClientInput | ExistingRecordRef
    tenant: NewTenantInput | ExistingRecordRef
    hive: { id: string; displayName: string; cluster: ClusterSpec; registry: RegistrySpec; trustRootRef?: string }
}

// The Owner's email and password are present only when a new tenant was created.
export type ProvisionSecrets = { ownerEmail?: string; ownerPassword?: string; agentToken: string }

export type ProvisionResult = { client: ClientRecord; tenant: TenantRecord; hive: HiveRecord; secrets: ProvisionSecrets }

export type ProvisionRollback = { rolledBack: readonly string[]; residue: readonly string[] }

/** Raised when provisioning failed mid-sequence. The message is a fixed safe label; it never carries secrets or the cause's message. */
export class ProvisionFailedError extends Error
{
    private static readonly ErrorName = 'ProvisionFailedError'
    private static readonly Label = 'provisioning failed; cause: '

    public readonly rollback: ProvisionRollback

    public constructor(rollback: ProvisionRollback, causeLabel: string)
    {
        super(ProvisionFailedError.Label + causeLabel)
        this.name = ProvisionFailedError.ErrorName
        this.rollback = rollback
    }
}

/** Which creation steps have completed, so rollback undoes exactly those. */
class CompletedSteps
{
    public client = false
    public tenantAttempted = false
    public tenant = false
    public hive = false
    public registration = false
}

export class ProvisioningOrchestrator
{
    private static readonly ClientPrefix = 'client:'
    private static readonly TenantPrefix = 'tenant:'
    private static readonly HivePrefix = 'hive:'
    private static readonly RegistrationPrefix = 'registration:'
    private static readonly IdpRealmPrefix = 'idp-realm:'
    private static readonly UnknownCause = 'UnknownError'

    public constructor(
        private readonly directory: PlatformDirectory,
        private readonly provisioning: TenantProvisioningService,
        private readonly deployments: PlatformDeploymentRegistry
    )
    {
    }

    public async Provision(input: ProvisionInput): Promise<ProvisionResult>
    {
        this.PreValidate(input)
        const completed = new CompletedSteps()
        try
        {
            const client = await this.ClientFor(input.client, completed)
            const { tenant, secrets } = await this.TenantFor(input, completed)
            const hive = await this.directory.CreateHive({
                id: input.hive.id,
                tenantId: input.tenant.id,
                displayName: input.hive.displayName,
                cluster: input.hive.cluster,
                registry: input.hive.registry,
                trustRootRef: input.hive.trustRootRef
            })
            completed.hive = true
            const agentToken = await this.deployments.RegisterHive(input.hive.id)
            completed.registration = true
            return { client, tenant, hive, secrets: { ...secrets, agentToken } }
        }
        catch (e)
        {
            const rollback = await this.Rollback(input, completed)
            throw new ProvisionFailedError(rollback, this.CauseLabel(e))
        }
    }

    // Creates the client, or returns the existing one (which rollback never touches).
    private async ClientFor(input: ProvisionInput['client'], completed: CompletedSteps): Promise<ClientRecord>
    {
        if (input.existing === true)
        {
            return this.directory.GetClient(input.id) as ClientRecord
        }
        const client = await this.directory.CreateClient(input)
        completed.client = true
        return client
    }

    // Provisions the tenant with its first Owner, or returns the existing one
    // (no Owner secrets then; rollback never touches it).
    private async TenantFor(input: ProvisionInput, completed: CompletedSteps): Promise<{ tenant: TenantRecord; secrets: Omit<ProvisionSecrets, 'agentToken'> }>
    {
        if (input.tenant.existing === true)
        {
            return { tenant: this.directory.GetTenant(input.tenant.id) as TenantRecord, secrets: {} }
        }
        completed.tenantAttempted = true
        const provisioned = await this.provisioning.Provision({
            id: input.tenant.id,
            clientId: input.client.id,
            displayName: input.tenant.displayName,
            ownerEmail: input.tenant.ownerEmail
        })
        completed.tenant = true
        return {
            tenant: provisioned.record,
            secrets: { ownerEmail: provisioned.record.ownerEmail ?? input.tenant.ownerEmail, ownerPassword: provisioned.ownerPassword }
        }
    }

    // Read-only: every new id is free, every existing reference resolves, and
    // an existing tenant belongs to the chosen client. Nothing is written on failure.
    private PreValidate(input: ProvisionInput): void
    {
        RecordId.Validate(input.client.id)
        RecordId.Validate(input.tenant.id)
        RecordId.Validate(input.hive.id)
        K8sManifestBuilder.AssertValidHiveId(input.hive.id)
        const client = this.directory.GetClient(input.client.id)
        if (input.client.existing === true && client === undefined)
        {
            throw new UnknownClientError(input.client.id)
        }
        if (input.client.existing !== true && client !== undefined)
        {
            throw new RecordExistsError(RecordKind.Client, input.client.id)
        }
        const tenant = this.directory.GetTenant(input.tenant.id)
        if (input.tenant.existing === true)
        {
            if (tenant === undefined)
            {
                throw new UnknownTenantError(input.tenant.id)
            }
            if (tenant.clientId !== input.client.id)
            {
                throw new TenantClientMismatchError(input.tenant.id, input.client.id)
            }
        }
        else if (tenant !== undefined)
        {
            throw new RecordExistsError(RecordKind.Tenant, input.tenant.id)
        }
        if (this.directory.GetHive(input.hive.id) !== undefined)
        {
            throw new RecordExistsError(RecordKind.Hive, input.hive.id)
        }
    }

    private async Rollback(input: ProvisionInput, completed: CompletedSteps): Promise<ProvisionRollback>
    {
        const rolledBack: string[] = []
        const residue: string[] = []
        if (completed.registration)
        {
            await this.Compensate(ProvisioningOrchestrator.RegistrationPrefix + input.hive.id, () => this.deployments.DeregisterHive(input.hive.id), rolledBack, residue)
        }
        if (completed.hive)
        {
            await this.Compensate(ProvisioningOrchestrator.HivePrefix + input.hive.id, () => this.directory.DeleteHive(input.hive.id), rolledBack, residue)
        }
        if (completed.tenant)
        {
            await this.Compensate(ProvisioningOrchestrator.TenantPrefix + input.tenant.id, () => this.directory.DeleteTenant(input.tenant.id), rolledBack, residue)
        }
        if (completed.tenantAttempted)
        {
            residue.push(ProvisioningOrchestrator.IdpRealmPrefix + input.tenant.id)
        }
        if (completed.client)
        {
            await this.Compensate(ProvisioningOrchestrator.ClientPrefix + input.client.id, () => this.directory.DeleteClient(input.client.id), rolledBack, residue)
        }
        return { rolledBack, residue }
    }

    private async Compensate(label: string, action: () => Promise<void>, rolledBack: string[], residue: string[]): Promise<void>
    {
        try
        {
            await action()
            rolledBack.push(label)
        }
        catch
        {
            residue.push(label)
        }
    }

    private CauseLabel(e: unknown): string
    {
        return e instanceof Error ? e.name : ProvisioningOrchestrator.UnknownCause
    }
}
