/**
 * Addressing for the in-cluster OCI registry (registry:2). Two reachabilities:
 * pods pull via the cluster Service DNS on the service port; the control plane
 * pushes via the host loopback on the kind-mapped node port.
 */
export class InClusterRegistry
{
    public static readonly RegistryName = 'pragmatic-registry'
    public static readonly Namespace = 'pragmatic-system'
    public static readonly Image = 'registry:2'
    public static readonly ServicePort = 5000
    public static readonly NodePort = 30500
    public static readonly DataClaimName = 'pragmatic-registry-data'
    public static readonly DataSize = '1Gi'
    public static readonly V2Path = '/v2/'

    private static readonly ClusterDomain = 'svc.cluster.local'
    private static readonly Separator = '.'
    private static readonly PortSeparator = ':'
    private static readonly HostLoopback = 'localhost'

    public static DnsHost(): string
    {
        return [
            InClusterRegistry.RegistryName,
            InClusterRegistry.Namespace,
            InClusterRegistry.ClusterDomain,
        ].join(InClusterRegistry.Separator)
    }

    public static PullBase(): string
    {
        return InClusterRegistry.DnsHost() + InClusterRegistry.PortSeparator + InClusterRegistry.ServicePort
    }

    public static PushBase(): string
    {
        return InClusterRegistry.HostLoopback + InClusterRegistry.PortSeparator + InClusterRegistry.NodePort
    }
}
