import type { ISecretStore } from '@pragmatic-tech-ai/todl-identity'
import type { IProvisionedSecretSource } from '../config/provisioned-secret-source.js'

/** A named ref could not be supplied by the active provisioned-secret source nor the existing store. */
export class ProvisionedSecretMissingError extends Error
{
    private static readonly Prefix = 'provisioned secret not available: '

    public readonly Reference: string

    public constructor(reference: string)
    {
        super(ProvisionedSecretMissingError.Prefix + reference)
        this.name = 'ProvisionedSecretMissingError'
        this.Reference = reference
    }
}

/** Writes a tenant's named secret refs through from a provisioned source into its encrypted store.
 *  The source is authoritative (write-through overwrites); a named ref satisfiable by neither the
 *  source nor the existing store fails closed. */
export class TenantSecretProvisioner
{
    private readonly source: IProvisionedSecretSource

    public constructor(source: IProvisionedSecretSource)
    {
        this.source = source
    }

    public async EnsureAsync(secrets: ISecretStore, references: readonly string[]): Promise<void>
    {
        for (const reference of references)
        {
            const value = reference.length === 0 ? null : this.source.Lookup(reference)
            if (value !== null)
            {
                await secrets.Put(reference, value)
                continue
            }
            const existing = reference.length === 0 ? null : await secrets.Get(reference)
            if (existing === null)
            {
                throw new ProvisionedSecretMissingError(reference)
            }
        }
    }
}
