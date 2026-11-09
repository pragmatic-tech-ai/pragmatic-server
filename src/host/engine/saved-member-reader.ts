import { checkAgainst, MetaKind, toJSON, WikiOriginKind } from '@pragmatic-tech-ai/todl'
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
    private static readonly RootSeparator = '/'

    public constructor(
        public readonly Storage: IStorage,
        public readonly Sources: readonly SourceFile[],
        public readonly Bases: readonly TodlDocument[],
        public readonly OriginOf: ReadonlyMap<string, WikiOrigin>,
        public readonly Models: readonly string[],
    )
    {
    }

    /** The sources keyed by the language service's absolute uris (unique across members, unlike storage-relative ones). */
    public AbsoluteSources(): SourceFile[]
    {
        return this.Sources.map(source => ({ uri: SavedMember.AbsoluteUri(this.Storage, source.uri), text: source.text }))
    }

    /** The language service keys files by absolute URI: the storage root (with a trailing separator) + the storage-relative path. */
    public static AbsoluteUri(storage: IStorage, uri: string): string
    {
        const root = storage.Root
        return (root.endsWith(SavedMember.RootSeparator) ? root : root + SavedMember.RootSeparator) + uri
    }

    /** True when the base node `id` was compiled from one of `storages` (an open in-solution member). */
    public static FromMember(origin: WikiOrigin | undefined, storages: ReadonlySet<IStorage>): boolean
    {
        return origin !== undefined && origin.kind === WikiOriginKind.OpenProject && storages.has(origin.storage)
    }
}

/**
 * Reads dev members from their storage, never from the language service's unsaved buffers. Shared by the model
 * workspace (which member owns a model) and the snapshot source (what the saved solution compiles to).
 */
export class SavedMemberReader
{
    private static readonly NamespaceSeparator = '.'

    public constructor(
        private readonly languageService: IDevLanguageService,
        private readonly collector: TodlSourceCollector = new TodlSourceCollector(),
    )
    {
    }

    public async Read(storage: IStorage): Promise<SavedMember>
    {
        const sources = await this.collector.Collect(storage)
        const resolved = await this.languageService.ResolveBasesFor(storage)
        const originOf = resolved.originOf ?? new Map<string, WikiOrigin>()
        return new SavedMember(storage, sources, resolved.bases, originOf, SavedMemberReader.DeclaredModels(resolved.bases, sources))
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
    private static DeclaredModels(bases: readonly TodlDocument[], sources: readonly SourceFile[]): string[]
    {
        if (sources.length === 0) return []
        const compiled = checkAgainst([...bases], [...sources])
        return toJSON(compiled.model).nodes
            .filter(node => node.metaKind === MetaKind.Model && compiled.provenance.has(node.id))
            .map(node => node.id)
    }
}
