import { checkAgainst, ModelDraft } from '@pragmatic-tech-ai/todl'
import type { ITodlDraftSession, ITodlModelWorkspace } from '@pragmatic-tech-ai/todl/engine'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { ConsoleDevWriteDiagnostics } from '../model/dev-model-writer.js'
import type { IDevLanguageService, IDevWriteDiagnostics } from '../model/dev-model-writer.js'
import type { IDevSolution } from './dev-solution.js'
import { SavedMember, SavedMemberReader } from './saved-member-reader.js'

/**
 * One dev model opened as a draft over its member's saved sources. Uris are relative to the member's storage. Each
 * write or delete lands in storage, then tells the language service the file's new text and waits for it to settle,
 * so the language-service view matches disk once a commit (or its compensation) returns. A refresh failure does not
 * fail the write: the file is persisted; it is logged and the view is stale until the next refresh.
 */
class ServerDraftSession implements ITodlDraftSession
{
    private static readonly DeletedText = ''

    public constructor(
        private readonly storage: IStorage,
        private readonly reader: SavedMemberReader,
        private readonly languageService: IDevLanguageService,
        private readonly diagnostics: IDevWriteDiagnostics,
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
        await this.storage.WriteText(uri, text)
        await this.Notify(uri, text)
    }

    public async DeleteFile(uri: string): Promise<void>
    {
        if (await this.storage.Exists(uri)) await this.storage.Delete(uri)
        // The language service has no close: an empty text drops the file's content from its view.
        await this.Notify(uri, ServerDraftSession.DeletedText)
    }

    private async Notify(uri: string, text: string): Promise<void>
    {
        try
        {
            this.languageService.DidChange(SavedMember.AbsoluteUri(this.storage, uri), text)
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
        return new ServerDraftSession(member.Storage, this.reader, this.languageService, this.diagnostics, draft, namespace, this.reader.SourceHash(member.Sources))
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
