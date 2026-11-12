import { createHash } from 'node:crypto'
import type { OciFetch, OciRequestInit } from '../oci-registry-client.js'

export interface FakeOciRequest
{
    url: string
    method: string
    headers: Record<string, string>
    body?: Uint8Array | string
}

interface StoredManifest
{
    bytes: Uint8Array
    contentType: string
}

/**
 * An in-memory OCI distribution registry behind the OciFetch seam, shared by the OCI client tests and the release tooling tests.
 * Optional behaviours: tag-list pagination (relative or absolute Link), a Bearer challenge with a known user name + token,
 * altered blob bytes, and distribution-style Accept enforcement on manifest reads.
 */
export class FakeOciRegistry
{
    private static readonly KeySeparator = '@'
    private static readonly DigestPrefix = 'sha256:'
    private static readonly HashAlgorithm = 'sha256'
    private static readonly Hex = 'hex'
    private static readonly Base64 = 'base64'
    private static readonly UserTokenSeparator = ':'
    private static readonly TokenPath = '/token'
    private static readonly V2Prefix = '/v2/'
    private static readonly RepoPattern = /^\/v2\/(.+?)\/(blobs|manifests|tags)\//
    private static readonly UploadsPath = '/blobs/uploads/'
    private static readonly BlobsPath = '/blobs/'
    private static readonly ManifestsPath = '/manifests/'
    private static readonly TagsListPath = '/tags/list'
    private static readonly MethodPost = 'POST'
    private static readonly MethodPut = 'PUT'
    private static readonly MethodHead = 'HEAD'
    private static readonly AuthorizationHeader = 'Authorization'
    private static readonly AcceptHeader = 'Accept'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly ChallengeHeader = 'WWW-Authenticate'
    private static readonly LocationHeader = 'Location'
    private static readonly LinkHeader = 'Link'
    private static readonly DigestHeader = 'Docker-Content-Digest'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly BasicPrefix = 'Basic '
    private static readonly DigestQuery = 'digest'
    private static readonly StartQuery = 'start'
    private static readonly AcceptSeparator = ', '
    private static readonly ChallengeService = 'registry.test'
    private static readonly BearerSeed = 'fake-oci-bearer'
    private static readonly BearerLabel = 'issued-'
    private static readonly BearerLength = 16
    private static readonly TamperByte = 0x21
    private static readonly StatusOk = 200
    private static readonly StatusCreated = 201
    private static readonly StatusAccepted = 202
    private static readonly StatusBadRequest = 400
    private static readonly StatusUnauthorized = 401
    private static readonly StatusNotFound = 404

    public readonly Requests: FakeOciRequest[] = []

    /** Blob bytes keyed by KeyOf(repo, digest). */
    private readonly blobs = new Map<string, Uint8Array>()
    /** Manifests keyed by KeyOf(repo, tag-or-digest). */
    private readonly manifests = new Map<string, StoredManifest>()
    private readonly tags = new Map<string, string[]>()
    private tagPageSize = 0
    private absoluteLinks = false
    private enforceAccept = false
    private credential: { username: string; token: string } | undefined
    private tamper = false
    private uploadCounter = 0
    private readonly issuedBearer: string

    public constructor(public readonly Origin: string = 'https://registry.test')
    {
        const S = FakeOciRegistry
        this.issuedBearer = S.BearerLabel + createHash(S.HashAlgorithm).update(S.BearerSeed).digest(S.Hex).slice(0, S.BearerLength)
    }

    public get Fetch(): OciFetch
    {
        return async (url, init) =>
        {
            this.Requests.push({ url, method: init.method, headers: { ...init.headers }, body: init.body })
            return this.Handle(url, init)
        }
    }

    /** The bearer value this registry issues after a successful Basic exchange. */
    public get IssuedBearer(): string
    {
        return this.issuedBearer
    }

    /** Requires every /v2 call to carry the issued bearer, challenging otherwise; the token endpoint accepts exactly this Basic credential. */
    public RequireBearer(username: string, token: string): void
    {
        this.credential = { username, token }
    }

    /** Lists tags in pages of `size` linked through `Link: rel="next"`; 0 disables pagination. */
    public PaginateTags(size: number): void
    {
        this.tagPageSize = size
    }

    /** Emits the pagination Link as an absolute URL instead of a registry-relative path. */
    public UseAbsoluteLinks(on: boolean): void
    {
        this.absoluteLinks = on
    }

    /** Like distribution: a manifest GET / HEAD whose Accept lacks the stored media type is answered 404. */
    public EnforceManifestAccept(on: boolean): void
    {
        this.enforceAccept = on
    }

    /** Serves altered bytes for every blob pull. */
    public TamperBlobs(on: boolean): void
    {
        this.tamper = on
    }

    public SetTags(repo: string, tags: string[]): void
    {
        this.tags.set(repo, [...tags])
    }

    /** Stores a manifest under a tag and its digest; returns the digest. */
    public PutManifest(repo: string, tag: string, bytes: Uint8Array, contentType: string): string
    {
        const digest = FakeOciRegistry.DigestOf(bytes)
        const stored = { bytes, contentType }
        this.manifests.set(FakeOciRegistry.KeyOf(repo, tag), stored)
        this.manifests.set(FakeOciRegistry.KeyOf(repo, digest), stored)
        const list = this.tags.get(repo) ?? []
        if (!list.includes(tag) && !tag.startsWith(FakeOciRegistry.DigestPrefix))
        {
            list.push(tag)
        }
        this.tags.set(repo, list)
        return digest
    }

    public HasBlob(repo: string, digest: string): boolean
    {
        return this.blobs.has(FakeOciRegistry.KeyOf(repo, digest))
    }

    public static DigestOf(bytes: Uint8Array): string
    {
        const S = FakeOciRegistry
        return S.DigestPrefix + createHash(S.HashAlgorithm).update(bytes).digest(S.Hex)
    }

    private static KeyOf(repo: string, reference: string): string
    {
        return repo + FakeOciRegistry.KeySeparator + reference
    }

    private Handle(url: string, init: OciRequestInit): Response
    {
        const S = FakeOciRegistry
        const target = new URL(url)
        if (target.pathname === S.TokenPath)
        {
            return this.IssueToken(init.headers?.[S.AuthorizationHeader])
        }
        if (this.credential !== undefined && init.headers?.[S.AuthorizationHeader] !== S.BearerPrefix + this.issuedBearer)
        {
            const scope = `repository:${this.RepoOf(target.pathname)}:pull,push`
            const challenge = `Bearer realm="${this.Origin}${S.TokenPath}",service="${S.ChallengeService}",scope="${scope}"`
            return new Response(null, { status: S.StatusUnauthorized, headers: { [S.ChallengeHeader]: challenge } })
        }
        return this.Route(target, init)
    }

    private IssueToken(authorization: string | undefined): Response
    {
        const S = FakeOciRegistry
        const expected = this.credential === undefined
            ? undefined
            : S.BasicPrefix + Buffer.from(this.credential.username + S.UserTokenSeparator + this.credential.token).toString(S.Base64)
        if (expected === undefined || authorization !== expected)
        {
            return new Response(null, { status: S.StatusUnauthorized })
        }
        return new Response(JSON.stringify({ token: this.issuedBearer }), { status: S.StatusOk })
    }

    private RepoOf(path: string): string
    {
        const match = FakeOciRegistry.RepoPattern.exec(path)
        return match === null ? '' : match[1]
    }

    private Route(target: URL, init: OciRequestInit): Response
    {
        const S = FakeOciRegistry
        const repo = this.RepoOf(target.pathname)
        const rest = target.pathname.slice((S.V2Prefix + repo).length)
        if (init.method === S.MethodPost && rest === S.UploadsPath)
        {
            const location = `${S.V2Prefix}${repo}${S.UploadsPath}${++this.uploadCounter}`
            return new Response(null, { status: S.StatusAccepted, headers: { [S.LocationHeader]: location } })
        }
        if (init.method === S.MethodPut && rest.startsWith(S.UploadsPath))
        {
            return this.StoreBlob(repo, target, init)
        }
        if (init.method === S.MethodPut && rest.startsWith(S.ManifestsPath))
        {
            const contentType = init.headers?.[S.ContentTypeHeader] ?? ''
            this.PutManifest(repo, rest.slice(S.ManifestsPath.length), FakeOciRegistry.BytesOf(init.body), contentType)
            return new Response(null, { status: S.StatusCreated })
        }
        if (rest.startsWith(S.ManifestsPath))
        {
            return this.ServeManifest(repo, rest.slice(S.ManifestsPath.length), init)
        }
        if (rest.startsWith(S.BlobsPath))
        {
            return this.ServeBlob(repo, rest.slice(S.BlobsPath.length))
        }
        if (rest === S.TagsListPath)
        {
            return this.ServeTags(repo, target)
        }
        return new Response(null, { status: S.StatusNotFound })
    }

    private StoreBlob(repo: string, target: URL, init: OciRequestInit): Response
    {
        const S = FakeOciRegistry
        const bytes = S.BytesOf(init.body)
        const digest = target.searchParams.get(S.DigestQuery)
        if (digest === null || digest !== S.DigestOf(bytes))
        {
            return new Response(null, { status: S.StatusBadRequest })
        }
        this.blobs.set(S.KeyOf(repo, digest), bytes)
        return new Response(null, { status: S.StatusCreated })
    }

    private ServeManifest(repo: string, reference: string, init: OciRequestInit): Response
    {
        const S = FakeOciRegistry
        const stored = this.manifests.get(S.KeyOf(repo, reference))
        if (stored === undefined || (this.enforceAccept && !this.Accepts(init.headers?.[S.AcceptHeader], stored.contentType)))
        {
            return new Response(null, { status: S.StatusNotFound })
        }
        const headers = { [S.ContentTypeHeader]: stored.contentType, [S.DigestHeader]: S.DigestOf(stored.bytes) }
        return new Response(init.method === S.MethodHead ? null : stored.bytes as BodyInit, { status: S.StatusOk, headers })
    }

    private Accepts(accept: string | undefined, mediaType: string): boolean
    {
        return accept !== undefined && accept.split(FakeOciRegistry.AcceptSeparator).includes(mediaType)
    }

    private ServeBlob(repo: string, digest: string): Response
    {
        const S = FakeOciRegistry
        const bytes = this.blobs.get(S.KeyOf(repo, digest))
        if (bytes === undefined)
        {
            return new Response(null, { status: S.StatusNotFound })
        }
        const served = this.tamper ? new Uint8Array([...bytes, S.TamperByte]) : bytes
        return new Response(served as BodyInit, { status: S.StatusOk })
    }

    private ServeTags(repo: string, target: URL): Response
    {
        const S = FakeOciRegistry
        const all = this.tags.get(repo)
        if (all === undefined)
        {
            return new Response(null, { status: S.StatusNotFound })
        }
        const start = Number(target.searchParams.get(S.StartQuery) ?? 0)
        const size = this.tagPageSize > 0 ? this.tagPageSize : all.length
        const page = all.slice(start, start + size)
        const headers: Record<string, string> = {}
        if (start + size < all.length)
        {
            const path = `${S.V2Prefix}${repo}${S.TagsListPath}?${S.StartQuery}=${start + size}`
            headers[S.LinkHeader] = `<${this.absoluteLinks ? this.Origin + path : path}>; rel="next"`
        }
        return new Response(JSON.stringify({ name: repo, tags: page }), { status: S.StatusOk, headers })
    }

    private static BytesOf(body: Uint8Array | string | undefined): Uint8Array
    {
        if (body === undefined)
        {
            return new Uint8Array()
        }
        return typeof body === 'string' ? new TextEncoder().encode(body) : body
    }
}
