import { execFile } from 'node:child_process'
import { get } from 'node:https'

export interface IdpContainerSpec
{
    tenantId: string
    port: number
    volumeName: string
    adminTokenRef: string
    image: string
}

/** Seam over the docker CLI: runs one docker invocation and returns stdout. */
export interface IDockerExec
{
    Run(args: string[]): Promise<string>
}

/** Default seam: the real `docker` CLI through execFile (stderr only on failure, never the argv). */
export class ExecFileDockerExec implements IDockerExec
{
    private static readonly Docker = 'docker'
    private static readonly MaxBuffer = 16 * 1024 * 1024
    private static readonly FailedSuffix = ' failed\n'

    public Run(args: string[]): Promise<string>
    {
        return new Promise<string>((resolve, reject) =>
        {
            execFile(ExecFileDockerExec.Docker, args, { maxBuffer: ExecFileDockerExec.MaxBuffer }, (err, stdout, stderr) =>
            {
                if (err)
                {
                    reject(new Error(`${ExecFileDockerExec.Docker} ${args[0] ?? ''}${ExecFileDockerExec.FailedSuffix}${stderr}`))
                    return
                }
                resolve(stdout)
            })
        })
    }
}

/** Docker lifecycle for one per-tenant pragmatic-idp container, run from the server image with the IdP entrypoint. */
export class IdpContainerEnv
{
    private static readonly NamePrefix = 'pragmatic-idp-'
    private static readonly DataMount = '/idp-data'
    private static readonly ContainerHost = 'host.docker.internal'
    private static readonly HostGateway = 'host-gateway'
    private static readonly BindAll = '0.0.0.0'
    private static readonly Script = 'dist/bin/pragmatic-idpd.js'
    private static readonly NodeBinary = 'node'
    private static readonly HealthPath = '/healthz'
    private static readonly LocalHost = '127.0.0.1'
    private static readonly DefaultAttempts = 60
    private static readonly DefaultIntervalMs = 1000
    private static readonly RequestTimeoutMs = 2000

    private static readonly Run = 'run'
    private static readonly Detach = '-d'
    private static readonly NameFlag = '--name'
    private static readonly EntrypointFlag = '--entrypoint'
    private static readonly PortFlag = '-p'
    private static readonly NoHealthcheck = '--no-healthcheck'
    private static readonly AddHostFlag = '--add-host'
    private static readonly VolumeFlag = '-v'
    private static readonly EnvFlag = '-e'
    private static readonly RmCmd = 'rm'
    private static readonly ForceFlag = '-f'
    private static readonly VolumeCmd = 'volume'

    private static readonly EnvPort = 'PRAGMATIC_IDP_PORT'
    private static readonly EnvBaseUrl = 'PRAGMATIC_IDP_BASE_URL'
    private static readonly EnvHost = 'PRAGMATIC_IDP_HOST'
    private static readonly EnvData = 'PRAGMATIC_IDP_DATA'
    private static readonly EnvAdminTokenRef = 'PRAGMATIC_IDP_ADMIN_TOKEN_REF'

    private static readonly HealthTimeoutMessage = 'IdP did not become healthy over TLS in time on port '
    private static readonly AttemptsSuffix = ' after attempts: '

    public constructor(private readonly exec: IDockerExec = new ExecFileDockerExec())
    {
    }

    public static ContainerName(tenantId: string): string
    {
        return `${IdpContainerEnv.NamePrefix}${tenantId}`
    }

    public static BaseUrl(port: number): string
    {
        return `https://${IdpContainerEnv.ContainerHost}:${port}`
    }

    public static RunArgs(spec: IdpContainerSpec): string[]
    {
        return [
            IdpContainerEnv.Run, IdpContainerEnv.Detach,
            IdpContainerEnv.NameFlag, IdpContainerEnv.ContainerName(spec.tenantId),
            IdpContainerEnv.EntrypointFlag, IdpContainerEnv.NodeBinary,
            IdpContainerEnv.PortFlag, `${spec.port}:${spec.port}`,
            IdpContainerEnv.NoHealthcheck,
            IdpContainerEnv.AddHostFlag, `${IdpContainerEnv.ContainerHost}:${IdpContainerEnv.HostGateway}`,
            IdpContainerEnv.VolumeFlag, `${spec.volumeName}:${IdpContainerEnv.DataMount}`,
            IdpContainerEnv.EnvFlag, `${IdpContainerEnv.EnvPort}=${spec.port}`,
            IdpContainerEnv.EnvFlag, `${IdpContainerEnv.EnvBaseUrl}=${IdpContainerEnv.BaseUrl(spec.port)}`,
            IdpContainerEnv.EnvFlag, `${IdpContainerEnv.EnvHost}=${IdpContainerEnv.BindAll}`,
            IdpContainerEnv.EnvFlag, `${IdpContainerEnv.EnvData}=${IdpContainerEnv.DataMount}`,
            IdpContainerEnv.EnvFlag, `${IdpContainerEnv.EnvAdminTokenRef}=${spec.adminTokenRef}`,
            spec.image, IdpContainerEnv.Script
        ]
    }

    public async Up(spec: IdpContainerSpec): Promise<void>
    {
        await this.exec.Run(IdpContainerEnv.RunArgs(spec))
    }

    /** Force-removes the container; absence is the desired end state. */
    public async Down(containerName: string): Promise<void>
    {
        await this.Tolerate([IdpContainerEnv.RmCmd, IdpContainerEnv.ForceFlag, containerName])
    }

    /** Force-removes the data volume; absence is the desired end state. */
    public async RemoveVolume(volumeName: string): Promise<void>
    {
        await this.Tolerate([IdpContainerEnv.VolumeCmd, IdpContainerEnv.RmCmd, IdpContainerEnv.ForceFlag, volumeName])
    }

    /** Polls the IdP liveness endpoint over verified TLS (trusting only `ca`) until HTTP 200. */
    public async WaitHealthy(port: number, ca: string | Buffer, attempts: number = IdpContainerEnv.DefaultAttempts, intervalMs: number = IdpContainerEnv.DefaultIntervalMs): Promise<void>
    {
        for (let i = 0; i < attempts; i++)
        {
            if (await this.Probe(port, ca))
            {
                return
            }
            if (i < attempts - 1)
            {
                await new Promise<void>(resolve => setTimeout(resolve, intervalMs))
            }
        }
        throw new Error(`${IdpContainerEnv.HealthTimeoutMessage}${port}${IdpContainerEnv.AttemptsSuffix}${attempts}`)
    }

    private async Tolerate(args: string[]): Promise<void>
    {
        try
        {
            await this.exec.Run(args)
        }
        catch
        {
            // absence is the desired end state
        }
    }

    private Probe(port: number, ca: string | Buffer): Promise<boolean>
    {
        return new Promise<boolean>(resolve =>
        {
            const req = get({ host: IdpContainerEnv.LocalHost, port, path: IdpContainerEnv.HealthPath, ca, rejectUnauthorized: true, timeout: IdpContainerEnv.RequestTimeoutMs }, res =>
            {
                res.resume()
                resolve(res.statusCode === 200)
            })
            req.on('timeout', () => req.destroy())
            req.on('error', () => resolve(false))
        })
    }
}
