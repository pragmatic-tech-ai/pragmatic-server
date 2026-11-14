/**
 * The local development Kubernetes cluster (LocalDevCluster: kind cluster `pragmatic-dev`, context `kind-pragmatic-dev`).
 * It replaces Docker Desktop's built-in Kubernetes for the dev stack's Local hive and the gated smokes.
 *
 *   npx tsx admin/control-plane/dev/dev-cluster.ts up     # create it when missing, then load the images onto its node
 *   npx tsx admin/control-plane/dev/dev-cluster.ts down   # delete it
 *
 * `up` is idempotent and re-loads the images every time, so a rebuilt `pragmatic-server:dev` reaches the node (a kind node
 * keeps its own image store; pods pull with IfNotPresent). It maps no host port: dev-up's Caddy holds :443 and the live-loop
 * e2e cluster maps :443 and :30500, so this cluster can run beside both. Requires docker and kind on PATH, and a built
 * `pragmatic-server:dev` (registry:2 and postgres:16 are pulled when missing).
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KindCli, type IKind } from '../kind.js'
import { NodeExecFile, type IExecFile } from '../kubectl.js'
import { LocalDevCluster } from '../local-dev-cluster.js'

export class DevCluster
{
    /** What the dev hive's workloads run: the server (and IdP), the in-cluster registry and environment Postgres. */
    public static readonly Images: readonly string[] = ['pragmatic-server:dev', 'registry:2', 'postgres:16']
    /** Built locally, never pulled. */
    public static readonly LocalOnlyImage = 'pragmatic-server:dev'
    private static readonly UpVerb = 'up'
    private static readonly DownVerb = 'down'
    private static readonly Docker = 'docker'
    private static readonly ImageVerb = 'image'
    private static readonly InspectVerb = 'inspect'
    private static readonly PullVerb = 'pull'
    private static readonly UsageMessage = 'usage: dev-cluster.ts up|down'
    private static readonly NotBuiltMessage = 'pragmatic-server:dev is not in the local docker store; build it first (see docker/Dockerfile)'
    private static readonly CreatingMessage = '[dev-cluster] creating kind cluster ' + LocalDevCluster.Name
    private static readonly ExistsMessage = '[dev-cluster] kind cluster ' + LocalDevCluster.Name + ' already exists'
    private static readonly LoadingPrefix = '[dev-cluster] loading '
    private static readonly ReadyMessage = '[dev-cluster] ready: context ' + LocalDevCluster.Context
    private static readonly DeletedMessage = '[dev-cluster] deleted ' + LocalDevCluster.Name
    private static readonly AbsentMessage = '[dev-cluster] ' + LocalDevCluster.Name + ' does not exist'

    public constructor(
        private readonly kind: IKind,
        private readonly exec: IExecFile,
        private readonly log: (line: string) => void = line => console.log(line))
    {
    }

    public static async Main(): Promise<void>
    {
        const D = DevCluster
        const cluster = new DevCluster(new KindCli(new NodeExecFile(), new NodeExecFile(KindCli.ImageLoadTimeoutMs)), new NodeExecFile())
        const verb = process.argv[2]
        if (verb === D.UpVerb)
        {
            await cluster.Up()
        }
        else if (verb === D.DownVerb)
        {
            await cluster.Down()
        }
        else
        {
            throw new Error(D.UsageMessage)
        }
    }

    /** Creates the cluster when missing (no host port mappings), then loads every image onto its node. */
    public async Up(): Promise<void>
    {
        const D = DevCluster
        const name = LocalDevCluster.Name
        if ((await this.kind.ListClusters()).includes(name))
        {
            this.log(D.ExistsMessage)
        }
        else
        {
            this.log(D.CreatingMessage)
            await this.kind.CreateCluster(name)
        }
        for (const image of D.Images)
        {
            await this.EnsureLocal(image)
            this.log(D.LoadingPrefix + image)
            await this.kind.LoadImage(image, name)
        }
        this.log(D.ReadyMessage)
    }

    /** Deletes the cluster; nothing to do when it does not exist. */
    public async Down(): Promise<void>
    {
        const D = DevCluster
        const name = LocalDevCluster.Name
        if (!(await this.kind.ListClusters()).includes(name))
        {
            this.log(D.AbsentMessage)
            return
        }
        await this.kind.DeleteCluster(name)
        this.log(D.DeletedMessage)
    }

    private async EnsureLocal(image: string): Promise<void>
    {
        const D = DevCluster
        try
        {
            await this.exec.Run(D.Docker, [D.ImageVerb, D.InspectVerb, image])
            return
        }
        catch
        {
            if (image === D.LocalOnlyImage)
            {
                throw new Error(D.NotBuiltMessage)
            }
        }
        await this.exec.Run(D.Docker, [D.PullVerb, image])
    }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    DevCluster.Main().catch(err =>
    {
        console.error((err as Error).message)
        process.exitCode = 1
    })
}
