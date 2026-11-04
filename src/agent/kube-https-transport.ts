import { readFileSync } from 'node:fs'
import { request } from 'node:https'

export type KubeHttpsResponse = { status: number; body: string }

/** Where the pod's service account credentials and the API server live. One home for the defaults. */
export class KubeServiceAccountDefaults
{
    public static readonly Root = '/var/run/secrets/kubernetes.io/serviceaccount'
    public static readonly TokenFile = 'token'
    public static readonly CaFile = 'ca.crt'
    public static readonly Host = 'kubernetes.default.svc'
    public static readonly TokenPath = KubeServiceAccountDefaults.Root + '/' + KubeServiceAccountDefaults.TokenFile
    public static readonly CaPath = KubeServiceAccountDefaults.Root + '/' + KubeServiceAccountDefaults.CaFile
}

/**
 * Shared node:https round trip to the Kubernetes API server. Node's global fetch cannot trust a custom CA
 * without undici, so TLS uses node:https with the service-account CA. The token file is reread on every
 * request (it rotates). Errors never carry the token, headers or body.
 */
export class KubeHttpsTransport
{
    private static readonly Utf8 = 'utf8'
    private static readonly AuthorizationHeader = 'Authorization'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly ContentLengthHeader = 'Content-Length'
    private static readonly AcceptHeader = 'Accept'
    private static readonly JsonType = 'application/json'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    private static readonly TimeoutMessage = 'kubernetes API request timed out'

    public constructor(
        private readonly tokenPath: string = KubeServiceAccountDefaults.TokenPath,
        private readonly caPath: string = KubeServiceAccountDefaults.CaPath,
        private readonly host: string = KubeServiceAccountDefaults.Host,
        private readonly port: number | undefined = undefined,
        private readonly timeoutMs: number = 10000)
    {
    }

    public Send(method: string, path: string, body: string | undefined, contentType: string): Promise<KubeHttpsResponse>
    {
        const token = readFileSync(this.tokenPath, KubeHttpsTransport.Utf8).trim()
        const ca = readFileSync(this.caPath)
        const headers: Record<string, string | number> = {
            [KubeHttpsTransport.AuthorizationHeader]: KubeHttpsTransport.BearerPrefix + token,
            [KubeHttpsTransport.AcceptHeader]: KubeHttpsTransport.JsonType,
        }
        if (body !== undefined)
        {
            headers[KubeHttpsTransport.ContentTypeHeader] = contentType
            headers[KubeHttpsTransport.ContentLengthHeader] = Buffer.byteLength(body)
        }
        return new Promise<KubeHttpsResponse>((resolve, reject) =>
        {
            const req = request({ host: this.host, port: this.port, path, method, headers, ca }, res =>
            {
                const chunks: Buffer[] = []
                res.on(KubeHttpsTransport.DataEvent, (chunk: Buffer) => chunks.push(chunk))
                res.on(KubeHttpsTransport.EndEvent, () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(KubeHttpsTransport.Utf8) }))
            })
            // generic message only: never the token, headers or body
            req.setTimeout(this.timeoutMs, () => req.destroy(new Error(KubeHttpsTransport.TimeoutMessage)))
            req.on(KubeHttpsTransport.ErrorEvent, reject)
            if (body !== undefined)
            {
                req.write(body)
            }
            req.end()
        })
    }
}
