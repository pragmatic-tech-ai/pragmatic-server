import { createHash } from 'node:crypto'

export type OciFetch = (
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: Uint8Array | string },
) => Promise<Response>

/** Basic credential for a registry that issues bearer tokens (GHCR: GitHub user name + personal access token). */
export type RegistryCredential = { username: string; token: string }

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
 * Answers a registry's `WWW-Authenticate: Bearer` challenge: exchanges the Basic credential at the challenge realm for a bearer,
 * caches it per scope, and retries the request once. Never echoes the credential, a Basic header or a bearer into an error.
 */
class RegistryBearerAuth
{
    private static readonly UnauthorizedStatus = 401
    private static readonly StatusOk = 200
    private static readonly AuthorizationHeader = 'Authorization'
    private static readonly ChallengeHeader = 'www-authenticate'
    private static readonly BearerScheme = 'Bearer'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly BasicPrefix = 'Basic '
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly MethodGet = 'GET'
    private static readonly RealmParam = 'realm'
    private static readonly ServiceParam = 'service'
    private static readonly ScopeParam = 'scope'
    private static readonly Separator = ':'
    private static readonly RepositoryScopePrefix = 'repository:'
    private static readonly NoScope = ''
    private static readonly ChallengeParam = /(\w+)="([^"]*)"/g
    private static readonly RefusedMessage = 'The OCI registry refused the credential'
    private static readonly UnreachableMessage = 'The OCI registry is unreachable'

    private readonly bearers = new Map<string, string>()

    public constructor(private readonly fetchFn: OciFetch, private readonly credential: RegistryCredential | undefined)
    {
    }

    public async Send(
        url: string,
        init: { method: string; headers?: Record<string, string>; body?: Uint8Array | string },
        repo: string,
    ): Promise<Response>
    {
        const S = RegistryBearerAuth
        const first = await this.Dispatch(url, init, this.CachedBearerFor(repo))
        if (first.status !== S.UnauthorizedStatus)
        {
            return first
        }
        const challenge = first.headers.get(S.ChallengeHeader)
        await this.Drain(first)
        if (this.credential === undefined || challenge === null || !challenge.startsWith(S.BearerScheme))
        {
            throw new OciResponseError(S.UnauthorizedStatus, S.RefusedMessage)
        }
        const params = S.ParseChallenge(challenge)
        const scope = params.get(S.ScopeParam) ?? S.NoScope
        const bearer = await this.IssueBearer(params, scope, this.credential)
        this.bearers.set(scope, bearer)
        const second = await this.Dispatch(url, init, bearer)
        if (second.status === S.UnauthorizedStatus)
        {
            await this.Drain(second)
            throw new OciResponseError(S.UnauthorizedStatus, S.RefusedMessage)
        }
        return second
    }

    private static ParseChallenge(challenge: string): Map<string, string>
    {
        const params = new Map<string, string>()
        for (const match of challenge.matchAll(RegistryBearerAuth.ChallengeParam))
        {
            params.set(match[1].toLowerCase(), match[2])
        }
        return params
    }

    private CachedBearerFor(repo: string): string | undefined
    {
        const prefix = RegistryBearerAuth.RepositoryScopePrefix + repo + RegistryBearerAuth.Separator
        let found: string | undefined
        for (const [scope, bearer] of this.bearers)
        {
            if (scope.startsWith(prefix))
            {
                found = bearer
            }
        }
        return found
    }

    private async Dispatch(
        url: string,
        init: { method: string; headers?: Record<string, string>; body?: Uint8Array | string },
        bearer: string | undefined,
    ): Promise<Response>
    {
        const S = RegistryBearerAuth
        const headers = bearer === undefined ? init.headers : { ...init.headers, [S.AuthorizationHeader]: S.BearerPrefix + bearer }
        try
        {
            return await this.fetchFn(url, { method: init.method, headers, body: init.body })
        }
        catch
        {
            throw new OciUnavailableError(S.UnreachableMessage)
        }
    }

    private async IssueBearer(params: Map<string, string>, scope: string, credential: RegistryCredential): Promise<string>
    {
        const S = RegistryBearerAuth
        const realm = params.get(S.RealmParam)
        if (realm === undefined)
        {
            throw new OciResponseError(S.UnauthorizedStatus, S.RefusedMessage)
        }
        const target = new URL(realm)
        const service = params.get(S.ServiceParam)
        if (service !== undefined)
        {
            target.searchParams.set(S.ServiceParam, service)
        }
        if (scope !== S.NoScope)
        {
            target.searchParams.set(S.ScopeParam, scope)
        }
        const basic = Buffer.from(credential.username + S.Separator + credential.token, S.Utf8).toString(S.Base64)
        let response: Response
        try
        {
            response = await this.fetchFn(target.toString(), { method: S.MethodGet, headers: { [S.AuthorizationHeader]: S.BasicPrefix + basic } })
        }
        catch
        {
            throw new OciUnavailableError(S.UnreachableMessage)
        }
        if (response.status !== S.StatusOk)
        {
            await this.Drain(response)
            throw new OciResponseError(S.UnauthorizedStatus, S.RefusedMessage)
        }
        const issued = await this.ReadToken(response)
        if (issued === undefined)
        {
            throw new OciResponseError(S.UnauthorizedStatus, S.RefusedMessage)
        }
        return issued
    }

    private async ReadToken(response: Response): Promise<string | undefined>
    {
        try
        {
            const body = await response.json() as { token?: unknown; access_token?: unknown }
            const value = body.token ?? body.access_token
            return typeof value === 'string' && value.length > 0 ? value : undefined
        }
        catch
        {
            return undefined
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
}

/**
 * A minimal OCI distribution v2 client over an injectable fetch seam: monolithic blob upload, manifest put, and blob / manifest
 * pull, plus tag listing, digest HEAD and single-layer artifact push / pull. An optional credential answers bearer challenges
 * (GHCR). Errors never echo response bodies or credentials.
 */
export class OciRegistryClient
{
    private static readonly V2Prefix = '/v2/'
    private static readonly UploadsPath = '/blobs/uploads/'
    private static readonly BlobsPath = '/blobs/'
    private static readonly ManifestsPath = '/manifests/'
    private static readonly TagsListPath = '/tags/list'
    private static readonly DigestQuery = 'digest'
    private static readonly DigestPrefix = 'sha256:'
    private static readonly HashAlgorithm = 'sha256'
    private static readonly Hex = 'hex'
    private static readonly LocationHeader = 'location'
    private static readonly LinkHeader = 'link'
    private static readonly DigestHeader = 'docker-content-digest'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly AcceptHeader = 'Accept'
    private static readonly OctetStream = 'application/octet-stream'
    private static readonly ManifestMediaType = 'application/vnd.oci.image.manifest.v1+json'
    private static readonly OciIndexMediaType = 'application/vnd.oci.image.index.v1+json'
    private static readonly DockerManifestListMediaType = 'application/vnd.docker.distribution.manifest.list.v2+json'
    private static readonly DockerManifestMediaType = 'application/vnd.docker.distribution.manifest.v2+json'
    private static readonly EmptyConfigMediaType = 'application/vnd.oci.empty.v1+json'
    private static readonly EmptyConfigJson = '{}'
    private static readonly AcceptSeparator = ', '
    private static readonly ManifestSchemaVersion = 2
    private static readonly MaxTagPages = 1000
    private static readonly MethodGet = 'GET'
    private static readonly MethodHead = 'HEAD'
    private static readonly MethodPost = 'POST'
    private static readonly MethodPut = 'PUT'
    private static readonly StatusOk = 200
    private static readonly StatusCreated = 201
    private static readonly StatusAccepted = 202
    private static readonly StatusNotFound = 404
    private static readonly TrailingSlash = /\/+$/
    private static readonly NextLink = /<([^>]*)>\s*;\s*rel="?next"?/i
    private static readonly NoSlash = ''
    private static readonly DigestShape = /^sha256:[0-9a-f]{64}$/
    private static readonly ReferenceShape = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,127}$/
    private static readonly BadDigestMessage = 'The OCI digest must be sha256:<64 hex characters>'
    private static readonly BadReferenceMessage = 'The OCI reference must be a tag or digest without slashes, queries or whitespace'
    private static readonly UnreachableMessage = 'The OCI registry is unreachable'
    private static readonly StatusMessagePrefix = 'The OCI registry answered HTTP '
    private static readonly NoLocationMessage = 'The OCI registry accepted the upload but returned no Location'
    private static readonly NoDigestMessage = 'The OCI registry answered a manifest HEAD without a digest'
    private static readonly BadTagsMessage = 'The OCI registry returned an unreadable tag list'
    private static readonly BadManifestMessage = 'The OCI manifest is not a single-layer artifact'
    private static readonly LayerMismatchMessage = 'The OCI layer bytes do not match the digest in the manifest'

    /** The default seam: the global fetch, with the body narrowed to what BodyInit accepts at runtime (Uint8Array is valid). */
    private static readonly GlobalFetch: OciFetch = (url, init) => fetch(url, init as RequestInit)

    private readonly baseUrl: string
    private readonly auth: RegistryBearerAuth

    public constructor(baseUrl: string, fetchFn: OciFetch = OciRegistryClient.GlobalFetch, credential?: RegistryCredential)
    {
        this.baseUrl = baseUrl.replace(OciRegistryClient.TrailingSlash, OciRegistryClient.NoSlash)
        this.auth = new RegistryBearerAuth(fetchFn, credential)
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
        const start = await this.Send(repo, S.MethodPost, this.RepoUrl(repo) + S.UploadsPath, S.StatusAccepted)
        const location = start.headers.get(S.LocationHeader)
        if (location === null)
        {
            throw new OciResponseError(start.status, S.NoLocationMessage)
        }
        const target = new URL(location, this.baseUrl)
        target.searchParams.set(S.DigestQuery, digest)
        await this.Send(repo, S.MethodPut, target.toString(), S.StatusCreated, { [S.ContentTypeHeader]: S.OctetStream }, bytes)
        return digest
    }

    public async PushManifest(repo: string, reference: string, manifestBytes: Uint8Array): Promise<string>
    {
        const S = OciRegistryClient
        S.AssertReference(reference)
        await this.Send(repo, S.MethodPut, this.RepoUrl(repo) + S.ManifestsPath + reference, S.StatusCreated, { [S.ContentTypeHeader]: S.ManifestMediaType }, manifestBytes)
        return S.DigestOf(manifestBytes)
    }

    public async PullManifest(repo: string, reference: string): Promise<Uint8Array>
    {
        const S = OciRegistryClient
        S.AssertReference(reference)
        return this.ReadBytes(await this.Send(repo, S.MethodGet, this.RepoUrl(repo) + S.ManifestsPath + reference, S.StatusOk))
    }

    public async PullBlob(repo: string, digest: string): Promise<Uint8Array>
    {
        const S = OciRegistryClient
        if (!S.DigestShape.test(digest))
        {
            throw new OciArgumentError(S.BadDigestMessage)
        }
        return this.ReadBytes(await this.Send(repo, S.MethodGet, this.RepoUrl(repo) + S.BlobsPath + digest, S.StatusOk))
    }

    /** All tags of a repository, following `Link: rel="next"` pagination; empty when the repository does not exist. */
    public async ListTags(repo: string): Promise<string[]>
    {
        const S = OciRegistryClient
        const tags: string[] = []
        let url: string | undefined = this.RepoUrl(repo) + S.TagsListPath
        for (let page = 0; url !== undefined; page++)
        {
            if (page >= S.MaxTagPages)
            {
                throw new OciResponseError(S.StatusOk, S.BadTagsMessage)
            }
            const response = await this.Request(S.MethodGet, url, repo)
            if (response.status === S.StatusNotFound)
            {
                await this.Drain(response)
                return tags
            }
            await this.Expect(response, S.StatusOk)
            tags.push(...await this.ReadTags(response))
            const next = S.NextLink.exec(response.headers.get(S.LinkHeader) ?? S.NoSlash)
            url = next === null ? undefined : new URL(next[1], this.baseUrl + S.V2Prefix).toString()
        }
        return tags
    }

    /** The manifest digest the registry reports for a tag or digest reference; undefined when it does not exist. */
    public async HeadManifest(repo: string, reference: string): Promise<string | undefined>
    {
        const S = OciRegistryClient
        S.AssertReference(reference)
        const accept = [S.OciIndexMediaType, S.ManifestMediaType, S.DockerManifestListMediaType, S.DockerManifestMediaType].join(S.AcceptSeparator)
        const response = await this.Request(S.MethodHead, this.RepoUrl(repo) + S.ManifestsPath + reference, repo, { [S.AcceptHeader]: accept })
        if (response.status === S.StatusNotFound)
        {
            await this.Drain(response)
            return undefined
        }
        await this.Expect(response, S.StatusOk)
        const digest = response.headers.get(S.DigestHeader)
        if (digest === null || !S.DigestShape.test(digest))
        {
            throw new OciResponseError(response.status, S.NoDigestMessage)
        }
        return digest
    }

    /** Pushes the empty config and the layer as blobs, then an OCI image manifest tagged `tag`; returns the manifest digest. */
    public async PushArtifact(
        repo: string,
        tag: string,
        artifactType: string,
        layerMediaType: string,
        layer: Uint8Array,
        annotations: Record<string, string>,
    ): Promise<string>
    {
        const S = OciRegistryClient
        const encoder = new TextEncoder()
        const config = encoder.encode(S.EmptyConfigJson)
        const configDigest = await this.PushBlob(repo, config)
        const layerDigest = await this.PushBlob(repo, layer)
        const manifest = {
            schemaVersion: S.ManifestSchemaVersion,
            mediaType: S.ManifestMediaType,
            artifactType,
            config: { mediaType: S.EmptyConfigMediaType, digest: configDigest, size: config.length },
            layers: [{ mediaType: layerMediaType, digest: layerDigest, size: layer.length }],
            annotations,
        }
        return this.PushManifest(repo, tag, encoder.encode(JSON.stringify(manifest)))
    }

    /** Pulls the artifact's manifest then its single layer, verifying the layer bytes against the manifest's digest. */
    public async PullArtifactLayer(repo: string, tag: string): Promise<{ layer: Uint8Array; layerDigest: string; annotations: Record<string, string> }>
    {
        const S = OciRegistryClient
        const manifestBytes = await this.PullManifest(repo, tag)
        let manifest: { layers?: Array<{ digest?: unknown }>; annotations?: Record<string, string> }
        try
        {
            manifest = JSON.parse(new TextDecoder().decode(manifestBytes))
        }
        catch
        {
            throw new OciResponseError(S.StatusOk, S.BadManifestMessage)
        }
        const layerDigest = manifest.layers?.length === 1 ? manifest.layers[0].digest : undefined
        if (typeof layerDigest !== 'string')
        {
            throw new OciResponseError(S.StatusOk, S.BadManifestMessage)
        }
        const layer = await this.PullBlob(repo, layerDigest)
        if (S.DigestOf(layer) !== layerDigest)
        {
            throw new OciResponseError(S.StatusOk, S.LayerMismatchMessage)
        }
        return { layer, layerDigest, annotations: manifest.annotations ?? {} }
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

    private async ReadTags(response: Response): Promise<string[]>
    {
        try
        {
            const body = await response.json() as { tags?: unknown }
            if (body.tags === null || body.tags === undefined)
            {
                return []
            }
            if (Array.isArray(body.tags) && body.tags.every(t => typeof t === 'string'))
            {
                return body.tags as string[]
            }
        }
        catch
        {
            // Falls through to the uniform unreadable-list error.
        }
        throw new OciResponseError(OciRegistryClient.StatusOk, OciRegistryClient.BadTagsMessage)
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

    private Request(method: string, url: string, repo: string, headers?: Record<string, string>, body?: Uint8Array): Promise<Response>
    {
        return this.auth.Send(url, { method, headers, body }, repo)
    }

    private async Expect(response: Response, expected: number): Promise<void>
    {
        if (response.status !== expected)
        {
            await this.Drain(response)
            throw new OciResponseError(response.status, OciRegistryClient.StatusMessagePrefix + response.status)
        }
    }

    private async Send(repo: string, method: string, url: string, expected: number, headers?: Record<string, string>, body?: Uint8Array): Promise<Response>
    {
        const response = await this.Request(method, url, repo, headers, body)
        await this.Expect(response, expected)
        return response
    }
}
