import { checkAgainst, ModelDraft } from '@pragmatic-tech-ai/todl'
import { EngineBridgeError, EngineBridgeErrorCode } from '@pragmatic-tech-ai/todl/engine'
import type { ITodlDraftSession, ITodlModelWorkspace } from '@pragmatic-tech-ai/todl/engine'
import { Disposable } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable, IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { IDevLanguageService } from './dev-language-service.js'
import type { IDevSolution } from './dev-solution.js'
import { TodlSourceCollector } from '../model/todl-source-collector.js'
import { SavedMember, SavedMemberReader } from './saved-member-reader.js'

/** Where a write's language-service refresh failure is reported; implementations log error names only (messages can carry paths). */
export interface IDevWriteDiagnostics
{
    RefreshFailed(error: unknown): void
}

export class ConsoleDevWriteDiagnostics implements IDevWriteDiagnostics
{
    private static readonly RefreshLine = 'dev model write persisted but the language-service refresh failed: '
    private static readonly UnknownName = 'UnknownError'

    public RefreshFailed(error: unknown): void
    {
        console.error(ConsoleDevWriteDiagnostics.RefreshLine + (error instanceof Error ? error.name : ConsoleDevWriteDiagnostics.UnknownName))
    }
}

/** A writer's hold on the tenant (its write lease): asked once per draft session before its first file write. */
export interface IWriteFence
{
    Held(): Promise<boolean>
}

/**
 * The one write fence the workspace's draft sessions check: dev writes are serialized, so the writer holding the
 * write mutex installs its lease here for the length of its write (and disposes it after). None installed: no check.
 */
export class WriteFenceSlot
{
    private current: IWriteFence | undefined

    public get Current(): IWriteFence | undefined
    {
        return this.current
    }

    public Install(fence: IWriteFence): IDisposable
    {
        this.current = fence
        return new Disposable(() =>
        {
            if (this.current === fence) this.current = undefined
        })
    }
}

/**
 * One dev model opened as a draft over its member's saved sources. Uris are relative to the member's storage.
 *
 * Every model of a member drafts over ALL the member's files, so two sessions of one commit can emit the same file.
 * Each write is therefore a per-file compare-and-swap: storage must still hold the file's text from when the session
 * opened (absent stays absent) or the text this session itself last put there, else it refuses with
 * `EngineBridgeError` code `Stale`, untouched: the connector fails the commit Stale, restores what it wrote, and does
 * not count the refused write as unrestored. A second model sharing a file cannot lose the first one's edit.
 *
 * Each write or delete lands in storage, then tells the language service (DidChange / DidDelete) and waits for it to
 * settle, so the language-service view matches disk once a commit (or its compensation) returns. A refresh failure
 * does not fail the write: the file is persisted; it is logged and the view is stale until the next refresh.
 * Constraint for the engine host: a connector commit awaits `WhenIdle()` once per file, so the host must not run its
 * upgrade inside the language-service queue while waiting on that commit, and a language-service change observed
 * mid-commit may reflect only some of the commit's files (upgrade from the snapshot once the commit returns).
 */
class ServerDraftSession implements ITodlDraftSession
{
    private static readonly StaleMessage = 'A model source file changed after its draft was opened'
    private static readonly FenceLostMessage = 'The tenant write lease was lost before the write could persist'

    /** What this session last put in a file: its text, or undefined after it deleted the file. */
    private readonly written = new Map<string, string | undefined>()
    /** True once the installed write fence held before this session's first write. */
    private fenced = false

    public constructor(
        private readonly storage: IStorage,
        private readonly reader: SavedMemberReader,
        private readonly languageService: IDevLanguageService,
        private readonly diagnostics: IDevWriteDiagnostics,
        private readonly opened: ReadonlyMap<string, string>,
        private readonly fences: WriteFenceSlot,
        public readonly Draft: ModelDraft,
        public readonly Namespace: string,
        public readonly SourceHash: string,
    )
    {
    }

    public CurrentSourceHash(): Promise<string>
    {
        return this.reader.CurrentSourceHash(this.storage)
    }

    public async ReadFile(uri: string): Promise<string | undefined>
    {
        return (await this.storage.Exists(uri)) ? await this.storage.ReadText(uri) : undefined
    }

    public async WriteFile(uri: string, text: string): Promise<void>
    {
        await this.Fence()
        await this.Guard(uri)
        await this.storage.WriteText(uri, text)
        this.written.set(uri, text)
        await this.Refresh(() => this.languageService.DidChange(this.AbsoluteUri(uri), text))
    }

    public async DeleteFile(uri: string): Promise<void>
    {
        await this.Fence()
        await this.Guard(uri)
        if (await this.storage.Exists(uri)) await this.storage.Delete(uri)
        this.written.set(uri, undefined)
        await this.Refresh(() => this.languageService.DidDelete(this.AbsoluteUri(uri)))
    }

    /**
     * Before the session's first write: the installed fence (the writer's lease) must still hold, else the write is
     * refused untouched as `Stale` (the connector restores nothing it did not write). Checked once: a restore of a
     * file this session wrote is never refused.
     */
    private async Fence(): Promise<void>
    {
        if (this.fenced) return
        const fence = this.fences.Current
        if (fence !== undefined && !(await fence.Held())) throw new EngineBridgeError(EngineBridgeErrorCode.Stale, ServerDraftSession.FenceLostMessage)
        this.fenced = true
    }

    /** Throws unless the file holds its opening text or the text this session last wrote (see the class comment). */
    private async Guard(uri: string): Promise<void>
    {
        const current = await this.ReadFile(uri)
        if (current === this.opened.get(uri)) return
        if (this.written.has(uri) && current === this.written.get(uri)) return
        throw new EngineBridgeError(EngineBridgeErrorCode.Stale, ServerDraftSession.StaleMessage)
    }

    private AbsoluteUri(uri: string): string
    {
        return TodlSourceCollector.AbsoluteUri(this.storage, uri)
    }

    private async Refresh(notify: () => void): Promise<void>
    {
        try
        {
            notify()
            await this.languageService.WhenIdle()
        }
        catch (error)
        {
            this.diagnostics.RefreshFailed(error)
        }
    }
}

/**
 * The dev tenant's `ITodlModelWorkspace`: a model is editable when one member's SAVED sources declare it. The owning
 * member, namespace (the model id prefix, else the solution name) and draft all come from storage, never from the
 * language service's unsaved buffers, so the draft agrees with the snapshot the engine was opened from. The solution
 * name and ids no member declares are not editable (the solution package owns the instances outside every model).
 */
export class ServerModelWorkspace implements ITodlModelWorkspace
{
    private readonly reader: SavedMemberReader

    public constructor(
        private readonly solution: () => Promise<IDevSolution | undefined>,
        private readonly languageService: IDevLanguageService,
        private readonly diagnostics: IDevWriteDiagnostics = new ConsoleDevWriteDiagnostics(),
        reader?: SavedMemberReader,
        private readonly fences: WriteFenceSlot = new WriteFenceSlot(),
    )
    {
        this.reader = reader ?? new SavedMemberReader(languageService)
    }

    public async OpenDraft(model: string): Promise<ITodlDraftSession | undefined>
    {
        const solution = await this.solution()
        if (solution === undefined || model === solution.Name) return undefined
        const member = await this.OwningMember(solution, model)
        if (member === undefined) return undefined
        const namespace = SavedMemberReader.NamespaceOf(model, solution.Name)
        const bases = checkAgainst([...member.Bases], []).model
        // `model` keeps a created instance in this model and the file declaring it (the re-emit keeps declared ids)
        const draft = ModelDraft.fromSources([bases], [...member.Sources], { namespace, model })
        const opened = new Map(member.Sources.map(source => [source.uri, source.text]))
        return new ServerDraftSession(member.Storage, this.reader, this.languageService, this.diagnostics, opened, this.fences, draft, namespace, this.reader.SourceHash(member.Sources))
    }

    /** The member whose saved sources declare `model` (the first, in member order), or undefined. */
    public async OwningMember(solution: IDevSolution, model: string): Promise<SavedMember | undefined>
    {
        for (const candidate of solution.Members.ToArray())
        {
            if (candidate.Storage === undefined) continue
            const member = await this.reader.Read(candidate.Storage)
            if (member.Models.includes(model)) return member
        }
        return undefined
    }
}
