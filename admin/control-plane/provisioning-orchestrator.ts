import { RecordId } from './platform-records.js'
import type { ClientRecord, ClusterSpec, HiveRecord, RegistrySpec, TenantRecord } from './platform-records.js'
import { RecordExistsError } from './platform-directory.js'
import type { PlatformDirectory } from './platform-directory.js'
import type { TenantProvisioningService } from './tenant-provisioning-service.js'
import type { PlatformDeploymentRegistry } from './platform-deployment-registry.js'

export type ProvisionInput = {
    client: { id: string; displayName: string; subscriptionRef?: string }
    tenant: { id: string; displayName: string; ownerEmail: string }
    hive: { id: string; displayName: string; cluster: ClusterSpec; registry: RegistrySpec; trustRootRef?: string }
}

export type ProvisionSecrets = { ownerEmail: string; ownerPassword: string; agentToken: string }

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
            const client = await this.directory.CreateClient(input.client)
            completed.client = true
            const provisioned = await this.provisioning.Provision({
                id: input.tenant.id,
                clientId: input.client.id,
                displayName: input.tenant.displayName,
                ownerEmail: input.tenant.ownerEmail
            })
            completed.tenant = true
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
            return {
                client,
                tenant: provisioned.record,
                hive,
                secrets: { ownerEmail: provisioned.record.ownerEmail ?? input.tenant.ownerEmail, ownerPassword: provisioned.ownerPassword, agentToken }
            }
        }
        catch (e)
        {
            const rollback = await this.Rollback(input, completed)
            throw new ProvisionFailedError(rollback, this.CauseLabel(e))
        }
    }

    private PreValidate(input: ProvisionInput): void
    {
        RecordId.Validate(input.client.id)
        RecordId.Validate(input.tenant.id)
        RecordId.Validate(input.hive.id)
        if (this.directory.GetClient(input.client.id) !== undefined)
        {
            throw new RecordExistsError(input.client.id)
        }
        if (this.directory.GetTenant(input.tenant.id) !== undefined)
        {
            throw new RecordExistsError(input.tenant.id)
        }
        if (this.directory.GetHive(input.hive.id) !== undefined)
        {
            throw new RecordExistsError(input.hive.id)
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
