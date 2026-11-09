import { createHash } from 'node:crypto'
import { checkAgainst, MetaKind, Severity, toJSON, WikiOriginKind } from '@pragmatic-tech-ai/todl'
import type { SourceFile, TodlDocument, WikiOrigin } from '@pragmatic-tech-ai/todl'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { IDevLanguageService } from '../model/dev-model-writer.js'
import { TodlSourceCollector } from '../model/todl-source-collector.js'

/**
 * One dev solution member as its SAVED files read: the `.todl` sources in its storage (storage-relative uris), the
 * bases the language service resolves for it, and the model ids its own sources declare.
 */
export class SavedMember
{
    public constructor(
        public readonly Storage: IStorage,
        public readonly Sources: readonly SourceFile[],
        public readonly Bases: readonly TodlDocument[],
        public readonly OriginOf: ReadonlyMap<string, WikiOrigin>,
        public readonly Models: readonly string[],
        /** `TodlSourceCollector.SourceHash` of `Sources`. */
        public readonly SourceHash: string,
        /** A content fingerprint of `Bases` and `OriginOf`: equal for freshly built but content-equal resolutions. */
        public readonly BasesHash: string,
    )
    {
    }

    /** The sources keyed by the language service's absolute uris (unique across members, unlike storage-relative ones). */
    public AbsoluteSources(): SourceFile[]
    {
        return this.Sources.map(source => ({ uri: TodlSourceCollector.AbsoluteUri(this.Storage, source.uri), text: source.text }))
    }

    /** True when the base node `id` was compiled from one of `storages` (an open in-solution member). */
    public static FromMember(origin: WikiOrigin | undefined, storages: ReadonlySet<IStorage>): boolean
    {
        return origin !== undefined && origin.kind === WikiOriginKind.OpenProject && storages.has(origin.storage)
    }
}

/** One member's declared-model compile: the models, and whether the compile was clean (no error diagnostics). */
export class DeclaredModels
{
    public constructor(public readonly Models: readonly string[], public readonly Clean: boolean)
    {
    }
}

/** A cached clean compile of the sources hashing to `SourceHash`. */
class CachedModels
{
    public constructor(public readonly SourceHash: string, public readonly Models: readonly string[])
    {
    }
}

/**
 * The declared models of each member, kept per storage for the sources they were compiled from: an unchanged member
 * (same `SourceHash`) is not recompiled. One entry per storage (the latest), dropped with the storage. The models a
 * member's OWN sources declare do not depend on its bases once they compile cleanly (a base's models are never its
 * own), so the source hash keys the entry; a compile with errors (an unresolved base, say) is never cached, so it is
 * retried on the next read.
 */
export class DeclaredModelCache
{
    private readonly entries = new WeakMap<IStorage, CachedModels>()

    public ModelsOf(storage: IStorage, sourceHash: string, compile: () => DeclaredModels): readonly string[]
    {
        const cached = this.entries.get(storage)
        if (cached !== undefined && cached.SourceHash === sourceHash) return cached.Models
        const compiled = compile()
        if (compiled.Clean) this.entries.set(storage, new CachedModels(sourceHash, compiled.Models))
        else this.entries.delete(storage)
        return compiled.Models
    }
}

/**
 * Content fingerprints of a member's resolved bases and their origins. The language service builds a live sibling's
 * base afresh on every resolution, so identity never repeats; content does. An open-project origin is fingerprinted
 * by its storage's stable per-reader number (storage objects are the solution's members, stable for its life).
 */
class BasesFingerprint
{
    private static readonly HashAlgorithm = 'sha256'
    private static readonly Separator = '\u0000'
    private static readonly OpenProjectTag = 'open:'
    private static readonly PackageTag = 'package:'
    private static readonly VersionSeparator = '@'

    private readonly storageIds = new WeakMap<IStorage, number>()
    private nextStorageId = 0

    public Of(bases: readonly TodlDocument[], originOf: ReadonlyMap<string, WikiOrigin>): string
    {
        const hash = createHash(BasesFingerprint.HashAlgorithm)
        for (const base of bases)
        {
            hash.update(JSON.stringify(base))
            hash.update(BasesFingerprint.Separator)
        }
        const origins = [...originOf].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        for (const [id, origin] of origins)
        {
            hash.update(id)
            hash.update(BasesFingerprint.Separator)
            hash.update(this.OriginText(origin))
            hash.update(BasesFingerprint.Separator)
        }
        return hash.digest('hex')
    }

    private OriginText(origin: WikiOrigin): string
    {
        if (origin.kind === WikiOriginKind.OpenProject) return BasesFingerprint.OpenProjectTag + this.StorageId(origin.storage)
        return BasesFingerprint.PackageTag + origin.id + BasesFingerprint.VersionSeparator + origin.version
    }

    private StorageId(storage: IStorage): number
    {
        let id = this.storageIds.get(storage)
        if (id === undefined)
        {
            id = this.nextStorageId++
            this.storageIds.set(storage, id)
        }
        return id
    }
}

/**
 * Reads dev members from their storage, never from the language service's unsaved buffers. Shared by the model
 * workspace (which member owns a model) and the snapshot source (what the saved solution compiles to); share one
 * reader between them so each unchanged member compiles once (see {@link DeclaredModelCache}).
 */
export class SavedMemberReader
{
    private static readonly NamespaceSeparator = '.'

    public constructor(
        private readonly languageService: IDevLanguageService,
        private readonly collector: TodlSourceCollector = new TodlSourceCollector(),
        private readonly cache: DeclaredModelCache = new DeclaredModelCache(),
    )
    {
    }

    private readonly fingerprint = new BasesFingerprint()

    public async Read(storage: IStorage): Promise<SavedMember>
    {
        const sources = await this.collector.Collect(storage)
        const resolved = await this.languageService.ResolveBasesFor(storage)
        const originOf = resolved.originOf ?? new Map<string, WikiOrigin>()
        const hash = this.collector.SourceHash(sources)
        const models = this.cache.ModelsOf(storage, hash, () => SavedMemberReader.DeclaredModels(resolved.bases, sources))
        return new SavedMember(storage, sources, resolved.bases, originOf, models, hash, this.fingerprint.Of(resolved.bases, originOf))
    }

    public SourceHash(sources: readonly SourceFile[]): string
    {
        return this.collector.SourceHash(sources)
    }

    /** The current hash of the storage's saved `.todl` sources. */
    public async CurrentSourceHash(storage: IStorage): Promise<string>
    {
        return this.collector.SourceHash(await this.collector.Collect(storage))
    }

    /** A model's namespace: the `modelId` prefix before its last `.`, else the solution name. */
    public static NamespaceOf(modelId: string, solutionName: string): string
    {
        const at = modelId.lastIndexOf(SavedMemberReader.NamespaceSeparator)
        return at < 0 ? solutionName : modelId.slice(0, at)
    }

    /** The model containers the member's OWN sources declare (a base's models belong to the base). */
    private static DeclaredModels(bases: readonly TodlDocument[], sources: readonly SourceFile[]): DeclaredModels
    {
        if (sources.length === 0) return new DeclaredModels([], true)
        const compiled = checkAgainst([...bases], [...sources])
        const models = toJSON(compiled.model).nodes
            .filter(node => node.metaKind === MetaKind.Model && compiled.provenance.has(node.id))
            .map(node => node.id)
        return new DeclaredModels(models, !compiled.diagnostics.some(diagnostic => diagnostic.severity === Severity.Error))
    }
}
