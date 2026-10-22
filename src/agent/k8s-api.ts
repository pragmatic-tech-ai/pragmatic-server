import { readFileSync } from 'node:fs'
import { request } from 'node:https'

interface IContainerSpec
{
    name: string
    image?: string
}

interface IDeploymentBody
{
    spec?: { template?: { spec?: { containers?: IContainerSpec[] } } }
}

interface IK8sResponse
{
    status: number
    body: string
}

export class InClusterK8sApi
{
    public static readonly DefaultTokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token'
    public static readonly DefaultCaPath = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'
    public static readonly DefaultHost = 'kubernetes.default.svc'

    private static readonly Utf8 = 'utf8'
    private static readonly DeploymentPathTemplate = '/apis/apps/v1/namespaces/{ns}/deployments/{dep}'
    private static readonly NamespaceToken = '{ns}'
    private static readonly DeploymentToken = '{dep}'
    private static readonly GetMethod = 'GET'
    private static readonly PatchMethod = 'PATCH'
    private static readonly AuthorizationHeader = 'Authorization'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly ContentLengthHeader = 'Content-Length'
    private static readonly AcceptHeader = 'Accept'
    private static readonly JsonType = 'application/json'
    private static readonly StrategicMergePatchType = 'application/strategic-merge-patch+json'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    private static readonly NotFound = 404
    private static readonly OkMin = 200
    private static readonly OkMax = 299
    private static readonly FailurePrefix = 'kubernetes API request failed with status '

    public constructor(
        private readonly tokenPath: string = InClusterK8sApi.DefaultTokenPath,
        private readonly caPath: string = InClusterK8sApi.DefaultCaPath,
        private readonly host: string = InClusterK8sApi.DefaultHost,
        private readonly port?: number)
    {
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

    // Node's global fetch cannot trust a custom CA without undici, so TLS to the API server uses node:https with the SA CA.
    private Send(method: string, path: string, body: string | undefined, contentType: string): Promise<IK8sResponse>
    {
        const token = readFileSync(this.tokenPath, InClusterK8sApi.Utf8).trim()
        const ca = readFileSync(this.caPath)
        const headers: Record<string, string | number> = {
            [InClusterK8sApi.AuthorizationHeader]: InClusterK8sApi.BearerPrefix + token,
            [InClusterK8sApi.AcceptHeader]: InClusterK8sApi.JsonType,
        }
        if (body !== undefined)
        {
            headers[InClusterK8sApi.ContentTypeHeader] = contentType
            headers[InClusterK8sApi.ContentLengthHeader] = Buffer.byteLength(body)
        }
        return new Promise<IK8sResponse>((resolve, reject) =>
        {
            const req = request({ host: this.host, port: this.port, path, method, headers, ca }, res =>
            {
                const chunks: Buffer[] = []
                res.on(InClusterK8sApi.DataEvent, (chunk: Buffer) => chunks.push(chunk))
                res.on(InClusterK8sApi.EndEvent, () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(InClusterK8sApi.Utf8) }))
            })
            req.on(InClusterK8sApi.ErrorEvent, reject)
            if (body !== undefined)
            {
                req.write(body)
            }
            req.end()
        })
    }
}
