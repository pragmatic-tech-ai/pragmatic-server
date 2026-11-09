import { checkAgainst, ModelDraft } from '@pragmatic-tech-ai/todl'
import type { ITodlDraftSession, ITodlModelWorkspace } from '@pragmatic-tech-ai/todl/engine'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { ConsoleDevWriteDiagnostics } from '../model/dev-model-writer.js'
import type { IDevLanguageService, IDevWriteDiagnostics } from '../model/dev-model-writer.js'
import type { IDevSolution } from './dev-solution.js'
import { TodlSourceCollector } from '../model/todl-source-collector.js'
import { SavedMember, SavedMemberReader } from './saved-member-reader.js'

/**
 * Thrown by a draft session's write when the file no longer holds what the session opened over (nor what the session
 * itself last wrote): another writer, typically the session of a second model declared in the same file within the
 * same connector commit, changed it. The connector restores what it wrote and reports PersistFailed: no lost edit.
 */
export class StaleSourceFileError extends Error
{
    private static readonly ErrorName = 'StaleSourceFileError'
    private static readonly StaleMessage = 'A model source file changed after its draft was opened'

    public constructor()
    {
        super(StaleSourceFileError.StaleMessage)
        this.name = StaleSourceFileError.ErrorName
    }
}

/**
 * One dev model opened as a draft over its member's saved sources. Uris are relative to the member's storage.
 *
 * Every model of a member drafts over ALL the member's files, so two sessions of one commit can emit the same file.
 * Each write is therefore a per-file compare-and-swap: storage must still hold the file's text from when the session
 * opened (absent stays absent) or the text this session itself last put there, else {@link StaleSourceFileError}.
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
    /** What this session last put in a file: its text, or undefined after it deleted the file. */
    private readonly written = new Map<string, string | undefined>()

    public constructor(
        private readonly storage: IStorage,
        private readonly reader: SavedMemberReader,
        private readonly languageService: IDevLanguageService,
        private readonly diagnostics: IDevWriteDiagnostics,
        private readonly opened: ReadonlyMap<string, string>,
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
        await this.Guard(uri)
        await this.storage.WriteText(uri, text)
        this.written.set(uri, text)
        await this.Refresh(() => this.languageService.DidChange(this.AbsoluteUri(uri), text))
    }

    public async DeleteFile(uri: string): Promise<void>
    {
        await this.Guard(uri)
        if (await this.storage.Exists(uri)) await this.storage.Delete(uri)
        this.written.set(uri, undefined)
        await this.Refresh(() => this.languageService.DidDelete(this.AbsoluteUri(uri)))
    }

    /** Throws unless the file holds its opening text or the text this session last wrote (see the class comment). */
    private async Guard(uri: string): Promise<void>
    {
        const current = await this.ReadFile(uri)
        if (current === this.opened.get(uri)) return
        if (this.written.has(uri) && current === this.written.get(uri)) return
        throw new StaleSourceFileError()
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
    )
    {
        this.reader = new SavedMemberReader(languageService)
    }

    public async OpenDraft(model: string): Promise<ITodlDraftSession | undefined>
    {
        const solution = await this.solution()
        if (solution === undefined || model === solution.Name) return undefined
        const member = await this.OwningMember(solution, model)
        if (member === undefined) return undefined
        const namespace = SavedMemberReader.NamespaceOf(model, solution.Name)
        const bases = checkAgainst([...member.Bases], []).model
        const draft = ModelDraft.fromSources([bases], [...member.Sources], { namespace })
        const opened = new Map(member.Sources.map(source => [source.uri, source.text]))
        return new ServerDraftSession(member.Storage, this.reader, this.languageService, this.diagnostics, opened, draft, namespace, this.reader.SourceHash(member.Sources))
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
