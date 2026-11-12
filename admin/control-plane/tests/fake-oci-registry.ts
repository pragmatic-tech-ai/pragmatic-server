import { createHash } from 'node:crypto'
import type { OciFetch } from '../oci-registry-client.js'

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
 * Optional behaviours: tag-list pagination, a Bearer challenge with a known user name + token, and altered blob bytes.
 */
export class FakeOciRegistry
{
    public readonly Requests: FakeOciRequest[] = []

    /** Blob bytes keyed by `<repo>@<digest>`. */
    private readonly blobs = new Map<string, Uint8Array>()
    /** Manifests keyed by `<repo>@<tag-or-digest>`. */
    private readonly manifests = new Map<string, StoredManifest>()
    private readonly tags = new Map<string, string[]>()
    private tagPageSize = 0
    private credential: { username: string; token: string } | undefined
    private tamper = false
    private uploadCounter = 0
    private readonly issuedBearer = 'issued-' + createHash('sha256').update('fake-oci-bearer').digest('hex').slice(0, 16)

    public constructor(public readonly Origin: string = 'https://registry.test')
    {
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

    /** Requests every /v2 call to carry the issued bearer, challenging otherwise; the token endpoint accepts exactly this Basic credential. */
    public RequireBearer(username: string, token: string): void
    {
        this.credential = { username, token }
    }

    /** Lists tags in pages of `size` linked through `Link: rel="next"`; 0 disables pagination. */
    public PaginateTags(size: number): void
    {
        this.tagPageSize = size
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
        this.manifests.set(repo + '@' + tag, stored)
        this.manifests.set(repo + '@' + digest, stored)
        const list = this.tags.get(repo) ?? []
        if (!list.includes(tag) && !tag.startsWith('sha256:'))
        {
            list.push(tag)
        }
        this.tags.set(repo, list)
        return digest
    }

    public HasBlob(repo: string, digest: string): boolean
    {
        return this.blobs.has(repo + '@' + digest)
    }

    public static DigestOf(bytes: Uint8Array): string
    {
        return 'sha256:' + createHash('sha256').update(bytes).digest('hex')
    }

    private Handle(url: string, init: { method: string; headers?: Record<string, string>; body?: Uint8Array | string }): Response
    {
        const target = new URL(url)
        if (target.pathname === '/token')
        {
            return this.IssueToken(init.headers?.Authorization)
        }
        if (this.credential !== undefined && init.headers?.Authorization !== 'Bearer ' + this.issuedBearer)
        {
            const challenge = `Bearer realm="${this.Origin}/token",service="registry.test",scope="repository:${this.RepoOf(target.pathname)}:pull,push"`
            return new Response(null, { status: 401, headers: { 'WWW-Authenticate': challenge } })
        }
        return this.Route(target, init)
    }

    private IssueToken(authorization: string | undefined): Response
    {
        const expected = this.credential === undefined
            ? undefined
            : 'Basic ' + Buffer.from(this.credential.username + ':' + this.credential.token).toString('base64')
        if (expected === undefined || authorization !== expected)
        {
            return new Response(null, { status: 401 })
        }
        return new Response(JSON.stringify({ token: this.issuedBearer }), { status: 200 })
    }

    private RepoOf(path: string): string
    {
        const match = /^\/v2\/(.+?)\/(blobs|manifests|tags)\//.exec(path)
        return match === null ? '' : match[1]
    }

    private Route(target: URL, init: { method: string; headers?: Record<string, string>; body?: Uint8Array | string }): Response
    {
        const repo = this.RepoOf(target.pathname)
        const rest = target.pathname.slice(('/v2/' + repo).length)
        if (init.method === 'POST' && rest === '/blobs/uploads/')
        {
            return new Response(null, { status: 202, headers: { Location: `/v2/${repo}/blobs/uploads/${++this.uploadCounter}` } })
        }
        if (init.method === 'PUT' && rest.startsWith('/blobs/uploads/'))
        {
            const bytes = FakeOciRegistry.BytesOf(init.body)
            const digest = target.searchParams.get('digest')
            if (digest !== FakeOciRegistry.DigestOf(bytes))
            {
                return new Response(null, { status: 400 })
            }
            this.blobs.set(repo + '@' + digest, bytes)
            return new Response(null, { status: 201 })
        }
        if (init.method === 'PUT' && rest.startsWith('/manifests/'))
        {
            const contentType = init.headers?.['Content-Type'] ?? ''
            this.PutManifest(repo, rest.slice('/manifests/'.length), FakeOciRegistry.BytesOf(init.body), contentType)
            return new Response(null, { status: 201 })
        }
        if (rest.startsWith('/manifests/'))
        {
            return this.ServeManifest(repo, rest.slice('/manifests/'.length), init.method)
        }
        if (rest.startsWith('/blobs/'))
        {
            return this.ServeBlob(repo, rest.slice('/blobs/'.length))
        }
        if (rest === '/tags/list')
        {
            return this.ServeTags(repo, target)
        }
        return new Response(null, { status: 404 })
    }

    private ServeManifest(repo: string, reference: string, method: string): Response
    {
        const stored = this.manifests.get(repo + '@' + reference)
        if (stored === undefined)
        {
            return new Response(null, { status: 404 })
        }
        const headers = { 'Content-Type': stored.contentType, 'Docker-Content-Digest': FakeOciRegistry.DigestOf(stored.bytes) }
        return new Response(method === 'HEAD' ? null : stored.bytes as BodyInit, { status: 200, headers })
    }

    private ServeBlob(repo: string, digest: string): Response
    {
        const bytes = this.blobs.get(repo + '@' + digest)
        if (bytes === undefined)
        {
            return new Response(null, { status: 404 })
        }
        return new Response((this.tamper ? new Uint8Array([...bytes, 0x21]) : bytes) as BodyInit, { status: 200 })
    }

    private ServeTags(repo: string, target: URL): Response
    {
        const all = this.tags.get(repo)
        if (all === undefined)
        {
            return new Response(null, { status: 404 })
        }
        const start = Number(target.searchParams.get('start') ?? '0')
        const size = this.tagPageSize > 0 ? this.tagPageSize : all.length
        const page = all.slice(start, start + size)
        const headers: Record<string, string> = {}
        if (start + size < all.length)
        {
            headers.Link = `</v2/${repo}/tags/list?start=${start + size}>; rel="next"`
        }
        return new Response(JSON.stringify({ name: repo, tags: page }), { status: 200, headers })
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
