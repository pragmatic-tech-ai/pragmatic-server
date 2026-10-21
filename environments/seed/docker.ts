import { execFile } from 'node:child_process'
import { get } from 'node:http'
import { TenantPurposeName } from './bundle.js'
import type { EnvDefinition, EnvDatabase } from './bundle.js'

export { EnvKind, TenantPurposeName } from './bundle.js'
export type { EnvDefinition } from './bundle.js'

/**
 * Docker container lifecycle for a local environment, via the `docker` CLI only.
 * Docker-touching methods are exercised by the integration smoke run, not unit tests.
 */
export class DockerEnv
{
    public static readonly ImageName = 'pragmatic-server:dev'

    private static readonly Docker = 'docker'
    private static readonly NamePrefix = 'pragmatic-env-'
    private static readonly VolumeSuffix = '-data'
    private static readonly InternalPort = '8080'
    private static readonly DataMount = '/data'
    private static readonly DataSeedMount = '/data-seed'
    private static readonly SeedMount = '/seed'
    private static readonly HealthPath = '/healthz'
    private static readonly LocalHost = '127.0.0.1'
    private static readonly HealthTimeoutMs = 60000
    private static readonly HealthIntervalMs = 1000
    private static readonly HealthRequestTimeoutMs = 2000
    private static readonly MaxBuffer = 16 * 1024 * 1024

    private static readonly Run = 'run'
    private static readonly Detach = '-d'
    private static readonly Rm = '--rm'
    private static readonly NameFlag = '--name'
    private static readonly PortFlag = '-p'
    private static readonly VolumeFlag = '-v'
    public static readonly EnvFlag = '-e'
    private static readonly EntrypointFlag = '--entrypoint'
    private static readonly Sh = 'sh'
    private static readonly ShCommandFlag = '-c'

    private static readonly TenantsMount = '/cfg/tenants.json'
    private static readonly SecretsMount = '/cfg/provisioned-secrets.json'
    private static readonly MasterKeyMount = '/run/secrets/master_key'
    private static readonly TenantsFile = 'tenants.json'
    private static readonly SecretsFile = 'provisioned-secrets.json'
    private static readonly MasterKeyFile = 'master.key'
    private static readonly DataSubdir = 'data'
    private static readonly ReadOnly = ':ro'

    private static readonly EnvBaseDir = 'PRAGMATIC_BASE_DIR'
    private static readonly EnvTenantsFile = 'PRAGMATIC_TENANTS_FILE'
    private static readonly EnvMasterKeyFile = 'PRAGMATIC_MASTER_KEY_FILE'
    private static readonly EnvSecretsFile = 'PRAGMATIC_PROVISIONED_SECRETS_FILE'
    private static readonly EnvPort = 'PRAGMATIC_PORT'
    private static readonly EnvDeploymentMode = 'PRAGMATIC_DEPLOYMENT_MODE'
    private static readonly DeploymentModeLocal = 'local'
    public static readonly EnvAllowedOrigins = 'PRAGMATIC_ALLOWED_ORIGINS'
    private static readonly LocalhostOriginPrefix = 'http://localhost:'

    private static readonly SeedMarkerName = '.env-seeded'
    private static readonly ImageCmd = 'image'
    private static readonly InspectCmd = 'inspect'
    private static readonly PsCmd = 'ps'
    private static readonly RmCmd = 'rm'
    private static readonly ForceFlag = '-f'
    private static readonly AllFlag = '-a'
    private static readonly FilterFlag = '--filter'
    private static readonly FormatFlag = '--format'
    private static readonly UserFlag = '--user'
    private static readonly RootUser = '0'
    private static readonly NameFilter = 'name='
    private static readonly PsFormat = 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    private static readonly RunningFormat = '{{.State.Running}}'
    private static readonly RunningTrue = 'true'
    private static readonly LogsCommand = 'logs'
    private static readonly HealthTimeoutMessage = 'Server did not become healthy in time on port '
    private static readonly ContainerExitedMessage = 'Container exited before becoming healthy: '

    private static readonly BuildHintPrefix = 'Image not found. Build it once with BuildKit from the workspace root architecture-agent/, which holds all sibling packages:\n  DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile --secret id=npmrc,src=<path-to>/.npmrc -t '
    private static readonly BuildHintSuffix = ' .'
    private static readonly VolumeCmd = 'volume'
    private static readonly VersionCmd = 'version'
    private static readonly DaemonUnreachableMessage = 'Docker daemon is unreachable. Start Docker and try again.'

    private static readonly NetworkCmd = 'network'
    private static readonly CreateCmd = 'create'
    private static readonly ExecCmd = 'exec'
    private static readonly NetworkFlag = '--network'
    private static readonly NetworkSuffix = '-net'
    private static readonly DbSuffix = '-db'
    private static readonly DbVolumeSuffix = '-db-data'
    private static readonly PostgresImage = 'postgres:16'
    private static readonly PostgresPort = '5432'
    private static readonly PostgresDataMount = '/var/lib/postgresql/data'
    private static readonly EnvPostgresPassword = 'POSTGRES_PASSWORD'
    private static readonly EnvPostgresUser = 'POSTGRES_USER'
    private static readonly EnvPostgresDb = 'POSTGRES_DB'
    private static readonly PgIsReady = 'pg_isready'
    private static readonly PgUserFlag = '-U'
    private static readonly PgDbFlag = '-d'
    private static readonly DbTimeoutMs = 60000
    private static readonly DbIntervalMs = 1000
    private static readonly FailedSuffix = ' failed'
    private static readonly NoDatabaseMessage = 'Environment has no database descriptor'
    private static readonly DbTimeoutMessage = 'Postgres did not become ready in time: '

    private static SeedScript(): string
    {
        const marker = `${DockerEnv.DataMount}/${DockerEnv.SeedMarkerName}`
        return `test -f ${marker} || { cp -a ${DockerEnv.SeedMount}/. ${DockerEnv.DataMount}/ && chmod -R a+rwX ${DockerEnv.DataMount} && touch ${marker}; }`
    }

    public static ContainerName(def: EnvDefinition): string
    {
        return `${DockerEnv.NamePrefix}${def.name}`
    }

    public static VolumeName(def: EnvDefinition): string
    {
        return `${DockerEnv.NamePrefix}${def.name}${DockerEnv.VolumeSuffix}`
    }

    public static NetworkName(def: EnvDefinition): string
    {
        return `${DockerEnv.NamePrefix}${def.name}${DockerEnv.NetworkSuffix}`
    }

    public static DbContainerName(def: EnvDefinition): string
    {
        return `${DockerEnv.NamePrefix}${def.name}${DockerEnv.DbSuffix}`
    }

    public static DbVolumeName(def: EnvDefinition): string
    {
        return `${DockerEnv.NamePrefix}${def.name}${DockerEnv.DbVolumeSuffix}`
    }

    /** The Postgres sidecar container; only valid for envs with a database descriptor. */
    public static PostgresRunArgs(def: EnvDefinition): string[]
    {
        const db = def.database
        if (db === undefined)
        {
            throw new Error(DockerEnv.NoDatabaseMessage)
        }
        return [
            DockerEnv.Run, DockerEnv.Detach, DockerEnv.NameFlag, DockerEnv.DbContainerName(def),
            DockerEnv.NetworkFlag, DockerEnv.NetworkName(def),
            DockerEnv.VolumeFlag, `${DockerEnv.DbVolumeName(def)}:${DockerEnv.PostgresDataMount}`,
            DockerEnv.EnvFlag, `${DockerEnv.EnvPostgresPassword}=${db.password}`,
            DockerEnv.EnvFlag, `${DockerEnv.EnvPostgresUser}=${db.user}`,
            DockerEnv.EnvFlag, `${DockerEnv.EnvPostgresDb}=${db.database}`,
            DockerEnv.PortFlag, `${db.hostPort}:${DockerEnv.PostgresPort}`,
            DockerEnv.PostgresImage
        ]
    }

    public static RunArgs(def: EnvDefinition, bundleDir: string): string[]
    {
        const args = [
            DockerEnv.Run, DockerEnv.Detach, DockerEnv.NameFlag, DockerEnv.ContainerName(def),
            DockerEnv.PortFlag, `${def.hostPort}:${DockerEnv.InternalPort}`,
            DockerEnv.VolumeFlag, `${DockerEnv.VolumeName(def)}:${DockerEnv.DataMount}`,
            DockerEnv.VolumeFlag, `${bundleDir}/${DockerEnv.TenantsFile}:${DockerEnv.TenantsMount}${DockerEnv.ReadOnly}`,
            DockerEnv.VolumeFlag, `${bundleDir}/${DockerEnv.SecretsFile}:${DockerEnv.SecretsMount}${DockerEnv.ReadOnly}`,
            DockerEnv.VolumeFlag, `${bundleDir}/${DockerEnv.MasterKeyFile}:${DockerEnv.MasterKeyMount}${DockerEnv.ReadOnly}`,
            DockerEnv.VolumeFlag, `${bundleDir}/${DockerEnv.DataSubdir}:${DockerEnv.DataSeedMount}${DockerEnv.ReadOnly}`,
            DockerEnv.EnvFlag, `${DockerEnv.EnvBaseDir}=${DockerEnv.DataMount}`,
            DockerEnv.EnvFlag, `${DockerEnv.EnvTenantsFile}=${DockerEnv.TenantsMount}`,
            DockerEnv.EnvFlag, `${DockerEnv.EnvMasterKeyFile}=${DockerEnv.MasterKeyMount}`,
            DockerEnv.EnvFlag, `${DockerEnv.EnvSecretsFile}=${DockerEnv.SecretsMount}`,
            DockerEnv.EnvFlag, `${DockerEnv.EnvPort}=${DockerEnv.InternalPort}`,
            DockerEnv.EnvFlag, `${DockerEnv.EnvDeploymentMode}=${DockerEnv.DeploymentModeLocal}`
        ]
        if (def.database !== undefined)
        {
            args.push(DockerEnv.NetworkFlag, DockerEnv.NetworkName(def))
        }
        if (def.purpose === TenantPurposeName.Runtime)
        {
            args.push(DockerEnv.EnvFlag, `${DockerEnv.EnvAllowedOrigins}=${DockerEnv.LocalhostOriginPrefix}${def.hostPort}`)
        }
        args.push(DockerEnv.ImageName)
        return args
    }

    /** The full one-time build command (the same text EnsureImage prints). */
    public static BuildCommand(): string
    {
        return `${DockerEnv.BuildHintPrefix}${DockerEnv.ImageName}${DockerEnv.BuildHintSuffix}`
    }

    /** Throws when the docker CLI/daemon is unreachable (distinguishes daemon-down from image-missing). */
    public async EnsureDaemon(): Promise<void>
    {
        try
        {
            await this.Exec([DockerEnv.VersionCmd])
        }
        catch
        {
            throw new Error(DockerEnv.DaemonUnreachableMessage)
        }
    }

    /** Removes the env's data volume; absence is the desired end state. */
    public async RemoveVolume(def: EnvDefinition): Promise<void>
    {
        try
        {
            await this.Exec([DockerEnv.VolumeCmd, DockerEnv.RmCmd, DockerEnv.VolumeName(def)])
        }
        catch
        {
            // volume rm on a missing volume errors; absence is the desired end state
        }
    }

    /** True iff the named container exists and is running. */
    public async RunningByName(containerName: string): Promise<boolean>
    {
        try
        {
            const out = await this.Exec([DockerEnv.InspectCmd, DockerEnv.FormatFlag, DockerEnv.RunningFormat, containerName])
            return out.trim() === DockerEnv.RunningTrue
        }
        catch
        {
            return false
        }
    }

    /** Checks the image exists; if not, prints the one-time BuildKit command (never builds: the build needs a secret). */
    public async EnsureImage(): Promise<boolean>
    {
        try
        {
            await this.Exec([DockerEnv.ImageCmd, DockerEnv.InspectCmd, DockerEnv.ImageName])
            return true
        }
        catch
        {
            console.error(DockerEnv.BuildCommand())
            return false
        }
    }

    /** Seeds the data volume (idempotent) then starts the server container detached. */
    public async Up(def: EnvDefinition, bundleDir: string): Promise<void>
    {
        await this.SeedVolume(def, bundleDir)
        await this.Down(def)
        if (def.database !== undefined)
        {
            // the network survives Stop (data is kept), so creation must tolerate an existing one
            await this.Tolerate([DockerEnv.NetworkCmd, DockerEnv.CreateCmd, DockerEnv.NetworkName(def)])
            await this.Exec(DockerEnv.PostgresRunArgs(def))
            await this.WaitDbReady(def, def.database)
        }
        await this.Exec(DockerEnv.RunArgs(def, bundleDir))
    }

    /** Polls pg_isready inside the sidecar until it accepts connections or the timeout elapses. */
    private async WaitDbReady(def: EnvDefinition, db: EnvDatabase): Promise<void>
    {
        const deadline = Date.now() + DockerEnv.DbTimeoutMs
        while (Date.now() < deadline)
        {
            try
            {
                await this.Exec([DockerEnv.ExecCmd, DockerEnv.DbContainerName(def), DockerEnv.PgIsReady, DockerEnv.PgUserFlag, db.user, DockerEnv.PgDbFlag, db.database])
                return
            }
            catch
            {
                // not ready yet; retry until the deadline
            }
            await new Promise<void>(resolve => setTimeout(resolve, DockerEnv.DbIntervalMs))
        }
        throw new Error(`${DockerEnv.DbTimeoutMessage}${DockerEnv.DbContainerName(def)}`)
    }

    /**
     * Stops and removes the containers. The DB volume and network are KEPT unless removeData is true
     * (Stop keeps them so data survives a restart; Delete passes true).
     */
    public async Down(def: EnvDefinition, removeData: boolean = false): Promise<void>
    {
        await this.Tolerate([DockerEnv.RmCmd, DockerEnv.ForceFlag, DockerEnv.ContainerName(def)])
        if (def.database === undefined)
        {
            return
        }
        await this.Tolerate([DockerEnv.RmCmd, DockerEnv.ForceFlag, DockerEnv.DbContainerName(def)])
        if (!removeData)
        {
            return
        }
        await this.Tolerate([DockerEnv.VolumeCmd, DockerEnv.RmCmd, DockerEnv.DbVolumeName(def)])
        await this.Tolerate([DockerEnv.NetworkCmd, DockerEnv.RmCmd, DockerEnv.NetworkName(def)])
    }

    private async Tolerate(args: string[]): Promise<void>
    {
        try
        {
            await this.Exec(args)
        }
        catch
        {
            // absence is the desired end state
        }
    }

    public async Status(): Promise<string>
    {
        return this.Exec([
            DockerEnv.PsCmd, DockerEnv.AllFlag,
            DockerEnv.FilterFlag, `${DockerEnv.NameFilter}${DockerEnv.NamePrefix}`,
            DockerEnv.FormatFlag, DockerEnv.PsFormat
        ])
    }

    public async Logs(def: EnvDefinition): Promise<string>
    {
        return this.Exec([DockerEnv.LogsCommand, DockerEnv.ContainerName(def)])
    }

    /** Polls the unauthenticated liveness endpoint until HTTP 200 or the timeout elapses. */
    public async WaitHealthy(port: number, def?: EnvDefinition): Promise<void>
    {
        const deadline = Date.now() + DockerEnv.HealthTimeoutMs
        while (Date.now() < deadline)
        {
            if (await this.Probe(port))
            {
                return
            }
            if (def && !(await this.IsRunning(def)))
            {
                throw new Error(`${DockerEnv.ContainerExitedMessage}${DockerEnv.ContainerName(def)}`)
            }
            await new Promise<void>(resolve => setTimeout(resolve, DockerEnv.HealthIntervalMs))
        }
        throw new Error(`${DockerEnv.HealthTimeoutMessage}${port}`)
    }

    /**
     * Mechanism: throwaway-container copy. TenantRegistry.OptionsFor reads
     * <PRAGMATIC_BASE_DIR>/<tenant>/{packages,applications,identity} (join(baseDir, tenantId, ...)),
     * so the pre-seeded tree must live inside the named volume mounted at /data; the read-only
     * /data-seed mount is not the server's base dir. A one-shot container copies the bundle data/
     * into the volume, guarded by a marker file so repeated Up calls never overwrite live state.
     */
    public async SeedVolume(def: EnvDefinition, bundleDir: string): Promise<void>
    {
        await this.Exec([
            DockerEnv.Run, DockerEnv.Rm, DockerEnv.UserFlag, DockerEnv.RootUser,
            DockerEnv.VolumeFlag, `${DockerEnv.VolumeName(def)}:${DockerEnv.DataMount}`,
            DockerEnv.VolumeFlag, `${bundleDir}/${DockerEnv.DataSubdir}:${DockerEnv.SeedMount}${DockerEnv.ReadOnly}`,
            DockerEnv.EntrypointFlag, DockerEnv.Sh,
            DockerEnv.ImageName,
            DockerEnv.ShCommandFlag, DockerEnv.SeedScript()
        ])
    }

    private IsRunning(def: EnvDefinition): Promise<boolean>
    {
        return this.RunningByName(DockerEnv.ContainerName(def))
    }

    private Probe(port: number): Promise<boolean>
    {
        return new Promise<boolean>(resolve =>
        {
            const req = get({ host: DockerEnv.LocalHost, port, path: DockerEnv.HealthPath, timeout: DockerEnv.HealthRequestTimeoutMs }, res =>
            {
                res.resume()
                resolve(res.statusCode === 200)
            })
            req.on('timeout', () => req.destroy())
            req.on('error', () => resolve(false))
        })
    }

    /** Redacted failure text: the docker subcommand and stderr only, never the arg list (args may carry secrets such as -e POSTGRES_PASSWORD=...). */
    public static FailureMessage(args: string[], stderr: string): string
    {
        return `${DockerEnv.Docker} ${args[0] ?? ''}${DockerEnv.FailedSuffix}
${stderr}`
    }

    private Exec(args: string[]): Promise<string>
    {
        return new Promise<string>((resolve, reject) =>
        {
            execFile(DockerEnv.Docker, args, { maxBuffer: DockerEnv.MaxBuffer }, (err, stdout, stderr) =>
            {
                if (err)
                {
                    reject(new Error(DockerEnv.FailureMessage(args, stderr)))
                    return
                }
                resolve(stdout)
            })
        })
    }
}
