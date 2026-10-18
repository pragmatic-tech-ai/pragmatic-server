import { ModelDraft, ModelDraftBaker, ModelDraftWriter, SnowflakeIdGenerator, checkAgainst } from '@pragmatic-tech-ai/todl'
import type { Cypher, SourceFile, TodlDocument } from '@pragmatic-tech-ai/todl'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { TodlSourceCollector } from './todl-source-collector.js'

/** The slice of the language service the writer needs (SolutionLanguageService satisfies it). */
export interface IDevLanguageService
{
    ResolveBasesFor(consumerStorage: IStorage): Promise<{ bases: TodlDocument[] }>
    DidChange(uri: string, text: string): void
    WhenIdle(): Promise<void>
    readonly GraphRevision: number
}

/** The model identity the read graph tags this member's repository with, plus the draft's own namespace. */
export interface DevModelIdentity
{
    model: string
    version: string
    namespace: string
}

export interface DevModelPrepared
{
    draft: ModelDraft
    writer: Cypher.ICypherWriter
    sources: SourceFile[]
}

/** Thrown when persisting fails; any partially written files have been restored. */
export class DevModelWriteFailedError extends Error
{
    constructor(message: string)
    {
        super(message)
        this.name = 'DevModelWriteFailedError'
    }
}

/**
 * Builds a ModelDraft from a dev member's .todl sources, exposes the Cypher writer over it, and
 * persists (with compensating rewrite) + refreshes the language service after a committed write.
 */
export class DevModelWriter
{
    private static readonly FailedPrefix = 'Failed to persist model write: '
    private static readonly RestoreFailedSuffix = ' (restore also failed for: '
    private static readonly RestoreFailedClose = ')'
    private static readonly ListSeparator = ', '

    constructor(
        private readonly languageService: IDevLanguageService,
        private readonly collector: TodlSourceCollector = new TodlSourceCollector(),
    ) {}

    public async Prepare(member: { Storage: IStorage }, identity: DevModelIdentity): Promise<DevModelPrepared>
    {
        const sources = await this.collector.Collect(member.Storage)
        const resolved = await this.languageService.ResolveBasesFor(member.Storage)
        const bases = checkAgainst(resolved.bases, []).model
        const draft = ModelDraft.fromSources([bases], sources, { namespace: identity.namespace })
        const writer = new ModelDraftWriter(draft, new SnowflakeIdGenerator(), d => ModelDraftBaker.Bake(d, { model: identity.model, version: identity.version }))
        return { draft, writer, sources }
    }

    public async Persist(draft: ModelDraft, member: { Storage: IStorage }): Promise<number>
    {
        const storage = member.Storage
        const targets = [...draft.toTodlByFile()]
        const snapshots = new Map<string, string | undefined>()
        for (const [uri] of targets)
        {
            snapshots.set(uri, (await storage.Exists(uri)) ? await storage.ReadText(uri) : undefined)
        }
        try
        {
            for (const [uri, text] of targets) await storage.WriteText(uri, text)
        }
        catch (error)
        {
            const unrestored = await this.Restore(storage, snapshots)
            const reason = error instanceof Error ? error.message : String(error)
            const suffix = unrestored.length > 0
                ? DevModelWriter.RestoreFailedSuffix + unrestored.join(DevModelWriter.ListSeparator) + DevModelWriter.RestoreFailedClose
                : ''
            throw new DevModelWriteFailedError(DevModelWriter.FailedPrefix + reason + suffix)
        }
        // Post-write refresh. Contract: the files are already written. If DidChange/WhenIdle throws
        // from here on, the files stay changed and the in-memory graph is stale until the next refresh.
        for (const [uri, text] of targets) this.languageService.DidChange(uri, text)
        await this.languageService.WhenIdle()
        return this.languageService.GraphRevision
    }

    public SourceHash(sources: readonly SourceFile[]): string
    {
        return this.collector.SourceHash(sources)
    }

    private async Restore(storage: IStorage, snapshots: ReadonlyMap<string, string | undefined>): Promise<string[]>
    {
        const failed: string[] = []
        for (const [uri, prior] of snapshots)
        {
            try
            {
                if (prior === undefined)
                {
                    if (await storage.Exists(uri)) await storage.Delete(uri)
                }
                else
                {
                    await storage.WriteText(uri, prior)
                }
            }
            catch
            {
                failed.push(uri)
            }
        }
        return failed
    }
}
