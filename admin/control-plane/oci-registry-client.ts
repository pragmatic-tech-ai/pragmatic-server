import { createHash } from 'node:crypto'

export type OciFetch = (
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: Uint8Array | string },
) => Promise<Response>

/** The registry could not be reached (the fetch itself threw). Never carries the underlying error text. */
export class OciUnavailableError extends Error
{
    private static readonly ErrorName = 'OciUnavailableError'

    public constructor(message: string)
    {
        super(message)
        this.name = OciUnavailableError.ErrorName
    }
}

/** A caller-supplied reference or digest had an unsafe shape; it is refused before any request. Never echoes the value. */
export class OciArgumentError extends Error
{
    private static readonly ErrorName = 'OciArgumentError'

    public constructor(message: string)
    {
        super(message)
        this.name = OciArgumentError.ErrorName
    }
}

/** The registry answered with an unexpected status. Carries the status number only, never the response body. */
export class OciResponseError extends Error
{
    private static readonly ErrorName = 'OciResponseError'

    public constructor(public readonly status: number, message: string)
    {
        super(message)
        this.name = OciResponseError.ErrorName
    }
}

/**
 * A minimal OCI distribution v2 client over an injectable fetch seam: monolithic blob upload, manifest put, and blob / manifest
 * pull. Errors never echo response bodies or credentials.
 */
export class OciRegistryClient
{
    private static readonly V2Prefix = '/v2/'
    private static readonly UploadsPath = '/blobs/uploads/'
    private static readonly BlobsPath = '/blobs/'
    private static readonly ManifestsPath = '/manifests/'
    private static readonly DigestQuery = 'digest'
    private static readonly DigestPrefix = 'sha256:'
    private static readonly HashAlgorithm = 'sha256'
    private static readonly Hex = 'hex'
    private static readonly LocationHeader = 'location'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly OctetStream = 'application/octet-stream'
    private static readonly ManifestMediaType = 'application/vnd.oci.image.manifest.v1+json'
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
    private static readonly MethodPut = 'PUT'
    private static readonly StatusOk = 200
    private static readonly StatusCreated = 201
    private static readonly StatusAccepted = 202
    private static readonly TrailingSlash = /\/+$/
    private static readonly NoSlash = ''
    private static readonly DigestShape = /^sha256:[0-9a-f]{64}$/
    private static readonly ReferenceShape = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,127}$/
    private static readonly BadDigestMessage = 'The OCI digest must be sha256:<64 hex characters>'
    private static readonly BadReferenceMessage = 'The OCI reference must be a tag or digest without slashes, queries or whitespace'
    private static readonly UnreachableMessage = 'The OCI registry is unreachable'
    private static readonly StatusMessagePrefix = 'The OCI registry answered HTTP '
    private static readonly NoLocationMessage = 'The OCI registry accepted the upload but returned no Location'

    /** The default seam: the global fetch, with the body narrowed to what BodyInit accepts at runtime (Uint8Array is valid). */
    private static readonly GlobalFetch: OciFetch = (url, init) => fetch(url, init as RequestInit)

    private readonly baseUrl: string

    public constructor(baseUrl: string, private readonly fetchFn: OciFetch = OciRegistryClient.GlobalFetch)
    {
        this.baseUrl = baseUrl.replace(OciRegistryClient.TrailingSlash, OciRegistryClient.NoSlash)
    }

    public static DigestOf(bytes: Uint8Array): string
    {
        return OciRegistryClient.DigestPrefix + createHash(OciRegistryClient.HashAlgorithm).update(bytes).digest(OciRegistryClient.Hex)
    }

    /** Monolithic upload: POST starts the session (202 + Location), then PUT with ?digest= completes it (201). */
    public async PushBlob(repo: string, bytes: Uint8Array): Promise<string>
    {
        const S = OciRegistryClient
        const digest = S.DigestOf(bytes)
        const start = await this.Send(S.MethodPost, this.RepoUrl(repo) + S.UploadsPath, S.StatusAccepted)
        const location = start.headers.get(S.LocationHeader)
        if (location === null)
        {
            throw new OciResponseError(start.status, S.NoLocationMessage)
        }
        const target = new URL(location, this.baseUrl)
        target.searchParams.set(S.DigestQuery, digest)
        await this.Send(S.MethodPut, target.toString(), S.StatusCreated, { [S.ContentTypeHeader]: S.OctetStream }, bytes)
        return digest
    }

    public async PushManifest(repo: string, reference: string, manifestBytes: Uint8Array): Promise<string>
    {
        const S = OciRegistryClient
        S.AssertReference(reference)
        await this.Send(S.MethodPut, this.RepoUrl(repo) + S.ManifestsPath + reference, S.StatusCreated, { [S.ContentTypeHeader]: S.ManifestMediaType }, manifestBytes)
        return S.DigestOf(manifestBytes)
    }

    public async PullManifest(repo: string, reference: string): Promise<Uint8Array>
    {
        const S = OciRegistryClient
        S.AssertReference(reference)
        return this.ReadBytes(await this.Send(S.MethodGet, this.RepoUrl(repo) + S.ManifestsPath + reference, S.StatusOk))
    }

    public async PullBlob(repo: string, digest: string): Promise<Uint8Array>
    {
        const S = OciRegistryClient
        if (!S.DigestShape.test(digest))
        {
            throw new OciArgumentError(S.BadDigestMessage)
        }
        return this.ReadBytes(await this.Send(S.MethodGet, this.RepoUrl(repo) + S.BlobsPath + digest, S.StatusOk))
    }

    private static AssertReference(reference: string): void
    {
        if (!OciRegistryClient.ReferenceShape.test(reference))
        {
            throw new OciArgumentError(OciRegistryClient.BadReferenceMessage)
        }
    }

    private RepoUrl(repo: string): string
    {
        return this.baseUrl + OciRegistryClient.V2Prefix + repo
    }

    private async ReadBytes(response: Response): Promise<Uint8Array>
    {
        try
        {
            return new Uint8Array(await response.arrayBuffer())
        }
        catch
        {
            throw new OciUnavailableError(OciRegistryClient.UnreachableMessage)
        }
    }

    private async Drain(response: Response): Promise<void>
    {
        try
        {
            await response.body?.cancel()
        }
        catch
        {
            // The body is discarded; a failed drain changes nothing.
        }
    }

    private async Send(method: string, url: string, expected: number, headers?: Record<string, string>, body?: Uint8Array): Promise<Response>
    {
        let response: Response
        try
        {
            response = await this.fetchFn(url, { method, headers, body })
        }
        catch
        {
            throw new OciUnavailableError(OciRegistryClient.UnreachableMessage)
        }
        if (response.status !== expected)
        {
            await this.Drain(response)
            throw new OciResponseError(response.status, OciRegistryClient.StatusMessagePrefix + response.status)
        }
        return response
    }
}
