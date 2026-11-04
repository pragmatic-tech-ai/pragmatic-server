import { KubeHttpsTransport, KubeServiceAccountDefaults } from './kube-https-transport.js'

interface IContainerSpec
{
    name: string
    image?: string
}

interface IDeploymentBody
{
    spec?: { template?: { spec?: { containers?: IContainerSpec[] } } }
}

interface IDeploymentListItem extends IDeploymentBody
{
    metadata?: { namespace?: string; name?: string }
    status?: { replicas?: number; readyReplicas?: number }
}

interface IDeploymentList
{
    items?: IDeploymentListItem[]
}

export interface IServerDeployment
{
    namespace: string
    deployment: string
    container: string
    runningImage: string | undefined
    ready: boolean
}

interface IK8sResponse
{
    status: number
    body: string
}

export class InClusterK8sApi
{
    public static readonly DefaultTokenPath = KubeServiceAccountDefaults.TokenPath
    public static readonly DefaultCaPath = KubeServiceAccountDefaults.CaPath
    public static readonly DefaultHost = KubeServiceAccountDefaults.Host

    private static readonly Empty = ''
    private static readonly DeploymentPathTemplate = '/apis/apps/v1/namespaces/{ns}/deployments/{dep}'
    private static readonly DeploymentsListPath = '/apis/apps/v1/deployments'
    private static readonly LabelSelectorParam = '?labelSelector='
    private static readonly ServerContainerName = 'server'
    private static readonly NamespaceToken = '{ns}'
    private static readonly DeploymentToken = '{dep}'
    private static readonly GetMethod = 'GET'
    private static readonly PatchMethod = 'PATCH'
    private static readonly JsonType = 'application/json'
    private static readonly StrategicMergePatchType = 'application/strategic-merge-patch+json'
    private static readonly NotFound = 404
    private static readonly OkMin = 200
    private static readonly OkMax = 299
    private static readonly FailurePrefix = 'kubernetes API request failed with status '

    private readonly transport: KubeHttpsTransport

    public constructor(
        tokenPath: string = InClusterK8sApi.DefaultTokenPath,
        caPath: string = InClusterK8sApi.DefaultCaPath,
        host: string = InClusterK8sApi.DefaultHost,
        port?: number)
    {
        this.transport = new KubeHttpsTransport(tokenPath, caPath, host, port)
    }

    public async ReadDeploymentImage(namespace: string, deployment: string, container: string): Promise<string | undefined>
    {
        const response = await this.Send(InClusterK8sApi.GetMethod, this.PathOf(namespace, deployment), undefined, InClusterK8sApi.JsonType)
        if (response.status === InClusterK8sApi.NotFound)
        {
            return undefined
        }
        InClusterK8sApi.EnsureOk(response)
        const body = JSON.parse(response.body) as IDeploymentBody
        return body.spec?.template?.spec?.containers?.find(c => c.name === container)?.image
    }

    public async PatchDeploymentImage(namespace: string, deployment: string, container: string, image: string): Promise<void>
    {
        const patch = JSON.stringify({ spec: { template: { spec: { containers: [{ name: container, image }] } } } })
        const response = await this.Send(InClusterK8sApi.PatchMethod, this.PathOf(namespace, deployment), patch, InClusterK8sApi.StrategicMergePatchType)
        InClusterK8sApi.EnsureOk(response)
    }

    public async ListServerDeployments(labelSelector: string): Promise<ReadonlyArray<IServerDeployment>>
    {
        const path = InClusterK8sApi.DeploymentsListPath + InClusterK8sApi.LabelSelectorParam + encodeURIComponent(labelSelector)
        const response = await this.Send(InClusterK8sApi.GetMethod, path, undefined, InClusterK8sApi.JsonType)
        InClusterK8sApi.EnsureOk(response)
        const list = JSON.parse(response.body) as IDeploymentList
        return (list.items ?? []).map(item => InClusterK8sApi.ToServerDeployment(item))
    }

    private static ToServerDeployment(item: IDeploymentListItem): IServerDeployment
    {
        const containers = item.spec?.template?.spec?.containers ?? []
        const chosen = containers.find(c => c.name === InClusterK8sApi.ServerContainerName) ?? containers[0]
        const replicas = item.status?.replicas ?? 0
        const readyReplicas = item.status?.readyReplicas ?? 0
        return {
            namespace: item.metadata?.namespace ?? InClusterK8sApi.Empty,
            deployment: item.metadata?.name ?? InClusterK8sApi.Empty,
            container: chosen?.name ?? InClusterK8sApi.Empty,
            runningImage: chosen?.image,
            ready: replicas > 0 && readyReplicas === replicas,
        }
    }

    private PathOf(namespace: string, deployment: string): string
    {
        return InClusterK8sApi.DeploymentPathTemplate
            .replace(InClusterK8sApi.NamespaceToken, encodeURIComponent(namespace))
            .replace(InClusterK8sApi.DeploymentToken, encodeURIComponent(deployment))
    }

    private static EnsureOk(response: IK8sResponse): void
    {
        if (response.status < InClusterK8sApi.OkMin || response.status > InClusterK8sApi.OkMax)
        {
            throw new Error(InClusterK8sApi.FailurePrefix + response.status)
        }
    }

    protected Send(method: string, path: string, body: string | undefined, contentType: string): Promise<IK8sResponse>
    {
        return this.transport.Send(method, path, body, contentType)
    }
}
