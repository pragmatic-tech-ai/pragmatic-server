import { BundleBuilder } from '../../environments/seed/bundle.js'
import type { EnvironmentRecord } from './environment-record.js'
import type { HiveRecord } from './platform-records.js'
import { EnvServerSeedSource } from './env-server-seed.js'
import { TemplateCatalog } from './template-catalog.js'

/** A provisioned Postgres sidecar; the password is referenced by secret name only. */
export type WorkloadDatabase = {
    image: string
    user: string
    database: string
    passwordRef: string
}

/** In-cluster OIDC federation of a served environment: its browser host base domain and the ca.crt-only Secret it trusts the IdP through. */
export type WorkloadFederation = {
    baseDomain: string
    /** Secret holding ONLY the public CA certificate (key ca.crt); never the IdP server key. */
    caSecretName: string
}

/** Backend-neutral description of what to run for one environment. Carries secret names, never values. */
export type EnvironmentWorkload = {
    environmentName: string
    /** The id the server reads its data dir by (data/<environmentId>/); differs from the name for e.g. Demo envs. */
    environmentId: string
    hiveId: string
    image: string
    serverPort: number
    env: Readonly<Record<string, string>>
    secretRefs: readonly string[]
    database?: WorkloadDatabase
    federation?: WorkloadFederation
}

export class EnvironmentWorkloadFactory
{
    private static readonly ServerImage = 'pragmatic-server:dev'
    private static readonly DatabaseImage = 'postgres:16'
    private static readonly ServerPort = 8080
    private static readonly PortEnvKey = 'PRAGMATIC_PORT'

    /** Database presence follows the real template definition (TemplateCatalog.Resolve), so it cannot drift from the docker model. */
    public static From(record: EnvironmentRecord, hive: HiveRecord): EnvironmentWorkload
    {
        const type = record.type ?? TemplateCatalog.DefaultTypeFor(record.template)
        const def = TemplateCatalog.Resolve(record.template, record.name, record.hostPort as number, type).def
        const secretRefs = [def.environmentId + BundleBuilder.AdminSecretSuffix]
        const workload: EnvironmentWorkload = {
            environmentName: record.name,
            environmentId: def.environmentId,
            hiveId: hive.id,
            image: EnvironmentWorkloadFactory.ServerImage,
            serverPort: EnvironmentWorkloadFactory.ServerPort,
            env: { [EnvironmentWorkloadFactory.PortEnvKey]: String(EnvironmentWorkloadFactory.ServerPort) },
            secretRefs,
        }
        if (def.database)
        {
            const passwordRef = BundleBuilder.DbSecretRef(def, def.database)
            secretRefs.push(passwordRef)
            workload.database = {
                image: EnvironmentWorkloadFactory.DatabaseImage,
                user: def.database.user,
                database: def.database.database,
                passwordRef,
            }
        }
        if (record.idpBaseDomain !== undefined)
        {
            workload.federation = { baseDomain: record.idpBaseDomain, caSecretName: EnvServerSeedSource.IdpCaSecretNameOf(record.name) }
        }
        return workload
    }
}
