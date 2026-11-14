/**
 * The local development Kubernetes cluster: a kind cluster `pragmatic-dev` that `dev/dev-cluster.ts up` creates (and
 * `dev-up.sh` brings up first). It replaces Docker Desktop's built-in Kubernetes as the default target of a Local hive
 * that names no cluster, of the gated real-cluster smokes (SmokeCluster) and of KindImageLoader. The live-loop e2e stack
 * keeps its own cluster, `pragmatic-e2e`.
 */
export class LocalDevCluster
{
    public static readonly Name = 'pragmatic-dev'
    /** kind names a cluster's kubectl context `kind-<name>`. */
    public static readonly Context = 'kind-' + LocalDevCluster.Name
    /** kind names a single-node cluster's node container `<name>-control-plane`. */
    public static readonly Node = LocalDevCluster.Name + '-control-plane'
}
