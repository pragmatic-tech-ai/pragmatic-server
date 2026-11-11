import { checkAgainst, toJSON, WikiOriginKind } from '@pragmatic-tech-ai/todl'
import type { TodlDocument, WikiOrigin } from '@pragmatic-tech-ai/todl'
import { Disposable, Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable, IStorage, StorageEntry } from '@pragmatic-tech-ai/todl-runtime'
import type { IUpgradeTimer } from '../bounded-wait.js'
import type { IDevLanguageService } from '../dev-language-service.js'
import type { IDevSolution, IDevSolutionMember } from '../dev-solution.js'
import { WriteFenceSlot } from '../server-model-workspace.js'
import type { IWriteFence } from '../server-model-workspace.js'

/** A write fence that always holds: a writer's lease that is never lost (writes fail closed without one). */
export class HeldFence implements IWriteFence
{
    public static readonly Instance = new HeldFence()

    public async Held(): Promise<boolean>
    {
        return true
    }

    /** A fence slot with the held fence installed, for a workspace driven without DevCypherExecute. */
    public static Slot(): WriteFenceSlot
    {
        const slot = new WriteFenceSlot()
        slot.Install(HeldFence.Instance)
        return slot
    }
}

/** A gate a test opens by hand. */
export class ManualGate
{
    public readonly Promise: Promise<void>
    private open: () => void = () => undefined

    public constructor()
    {
        this.Promise = new Promise<void>(resolve => { this.open = resolve })
    }

    public Open(): void
    {
        this.open()
    }
}

/** A timer seam the test elapses by hand: every started work stays pending until FireAll (or its handle's dispose). */
export class ManualTimer implements IUpgradeTimer
{
    private readonly pending = new Set<() => void>()
    private started: ManualGate = new ManualGate()

    public get Pending(): number
    {
        return this.pending.size
    }

    public Start(_delayMs: number, work: () => void): IDisposable
    {
        this.pending.add(work)
        this.started.Open()
        return new Disposable(() => { this.pending.delete(work) })
    }

    /** Resolves once some work is pending (at once when one already is). */
    public WhenStarted(): Promise<void>
    {
        if (this.pending.size > 0) return Promise.resolve()
        this.started = new ManualGate()
        return this.started.Promise
    }

    public FireAll(): void
    {
        const works = [...this.pending]
        this.pending.clear()
        for (const work of works) work()
    }
}

/** An in-memory member storage rooted at `Root`. */
export class MemoryStorage implements IStorage
{
    private static readonly Separator = '/'
    private static readonly MissingPrefix = 'missing '
    public readonly Files = new Map<string, string>()
    /** While set, every write waits for it before it lands (a slow, or hung, disk). */
    public Hold: Promise<void> | undefined
    /** Writes started (held ones included). */
    public Started = 0
    private writing = new ManualGate()

    public constructor(public readonly Root: string, files: Readonly<Record<string, string>> = {})
    {
        for (const [path, text] of Object.entries(files)) this.Files.set(path, text)
    }

    public async ReadText(path: string): Promise<string>
    {
        const text = this.Files.get(path)
        if (text === undefined) throw new Error(MemoryStorage.MissingPrefix + path)
        return text
    }

    public async ReadBytes(path: string): Promise<Uint8Array>
    {
        return new TextEncoder().encode(await this.ReadText(path))
    }

    public async WriteText(path: string, content: string): Promise<void>
    {
        this.Started += 1
        this.writing.Open()
        if (this.Hold !== undefined) await this.Hold
        this.Files.set(path, content)
    }

    /** Resolves once a write has started (at once when one already did). */
    public WhenWriting(): Promise<void>
    {
        return this.writing.Promise
    }

    public async WriteBytes(path: string, bytes: Uint8Array): Promise<void>
    {
        this.Files.set(path, new TextDecoder().decode(bytes))
    }

    public async Exists(path: string): Promise<boolean>
    {
        return this.Files.has(path)
    }

    public async Delete(path: string): Promise<void>
    {
        this.Files.delete(path)
    }

    public async CreateDirectory(): Promise<void>
    {
    }

    public async Rename(from: string, to: string): Promise<void>
    {
        this.Files.set(to, await this.ReadText(from))
        this.Files.delete(from)
    }

    public async List(path: string): Promise<readonly StorageEntry[]>
    {
        const prefix = path === '' ? '' : path + MemoryStorage.Separator
        const seen = new Map<string, StorageEntry>()
        for (const key of this.Files.keys())
        {
            if (!key.startsWith(prefix)) continue
            const rest = key.slice(prefix.length)
            const slash = rest.indexOf(MemoryStorage.Separator)
            const name = slash < 0 ? rest : rest.slice(0, slash)
            seen.set(name, { Name: name, IsDirectory: slash >= 0 })
        }
        return [...seen.values()]
    }
}

/** The language service's graph-change payload, empty in the fake. */
export class FakeGraphChange
{
    public readonly memberIds: readonly string[] = []
    public readonly fileIds: readonly string[] = []
}

/** What the fake resolves for one member storage: its bases and their origins. */
class ResolvedBases
{
    public constructor(public readonly Bases: TodlDocument[], public readonly OriginOf: ReadonlyMap<string, WikiOrigin>)
    {
    }
}

/**
 * The dev language-service slice over memory: DidChange records the uri and text as an unsaved buffer (never
 * written to storage, like the real service's live documents); bases are a published schema unless set per storage.
 */
export class FakeLanguageService implements IDevLanguageService
{
    public GraphRevision = 1
    public readonly Changes: string[] = []
    public readonly Deletes: string[] = []
    public readonly Buffers = new Map<string, string>()
    public Idles = 0
    /** Raised by {@link FakeLanguageService.RaiseGraphChanged} only (the fake never reloads on its own). */
    public readonly GraphChanged = new Signal<FakeGraphChange>()
    /** Runs inside each WhenIdle, while a writer awaits it (a commit's per-file refresh). */
    public OnIdle: () => void = () => undefined
    /** Fails ResolveBasesFor while set. */
    public ResolveFailure: Error | undefined
    /** While set, ResolveBasesFor waits for it (a hung recompile). */
    public ResolveHold: Promise<void> | undefined
    private readonly basesOf = new Map<IStorage, () => ResolvedBases>()

    public RaiseGraphChanged(): void
    {
        this.GraphChanged.emit(new FakeGraphChange())
    }

    public async ResolveBasesFor(consumerStorage: IStorage): Promise<{ bases: TodlDocument[]; originOf: ReadonlyMap<string, WikiOrigin> }>
    {
        if (this.ResolveFailure !== undefined) throw this.ResolveFailure
        if (this.ResolveHold !== undefined) await this.ResolveHold
        const resolved = this.basesOf.get(consumerStorage)?.() ?? new ResolvedBases([EngineHostFx.SchemaDocument()], new Map())
        return { bases: resolved.Bases, originOf: resolved.OriginOf }
    }

    public DidChange(uri: string, text: string): void
    {
        this.Changes.push(uri)
        this.Buffers.set(uri, text)
        this.GraphRevision += 1
    }

    public DidDelete(uri: string): void
    {
        this.Deletes.push(uri)
        this.Buffers.delete(uri)
        this.GraphRevision += 1
    }

    public async WhenIdle(): Promise<void>
    {
        this.Idles += 1
        this.OnIdle()
    }

    /**
     * Makes `consumer` resolve `producer`'s compiled sources as a live in-solution base (tagged OpenProject), compiled
     * afresh on every resolution like the real resolver (new objects, same content).
     */
    public ConsumeSibling(consumer: IStorage, producer: MemoryStorage): void
    {
        this.basesOf.set(consumer, () => FakeLanguageService.SiblingBases(producer))
    }

    private static SiblingBases(producer: MemoryStorage): ResolvedBases
    {
        const doc = toJSON(checkAgainst([], [...producer.Files].map(([uri, text]) => ({ uri, text }))).model)
        const originOf = new Map<string, WikiOrigin>()
        for (const node of doc.nodes) originOf.set(node.id, { kind: WikiOriginKind.OpenProject, storage: producer })
        return new ResolvedBases([doc], originOf)
    }
}

/** A solution over memory members. */
export class FakeSolution implements IDevSolution
{
    public readonly Members: { ToArray(): readonly IDevSolutionMember[] }

    public constructor(public readonly Name: string, members: readonly IDevSolutionMember[])
    {
        this.Members = { ToArray: () => members }
    }
}

/** Two members of solution `sol`: `a` declares model shop.M (c1 Ada), `b` declares shop.N (c2 Bo), both in `model.todl`. */
export class EngineHostFx
{
    public static readonly SolutionName = 'sol'
    public static readonly ModelM = 'shop.M'
    public static readonly ModelN = 'shop.N'
    public static readonly Namespace = 'shop'
    public static readonly File = 'model.todl'
    public static readonly RootA = 'mem/a'
    public static readonly RootB = 'mem/b/'
    public static readonly UriA = 'mem/a/model.todl'
    public static readonly UriB = 'mem/b/model.todl'
    public static readonly C1 = 'shop.c1'
    public static readonly C2 = 'shop.c2'
    public static readonly Schema = 'namespace shop {\n  concept Customer { name : string?; }\n}\n'
    public static readonly SourceA = 'namespace shop {\n  model M : shop {\n    Customer c1 { name = "Ada"; }\n  }\n}\n'
    public static readonly SourceB = 'namespace shop {\n  model N : shop {\n    Customer c2 { name = "Bo"; }\n  }\n}\n'

    public readonly A = new MemoryStorage(EngineHostFx.RootA, { [EngineHostFx.File]: EngineHostFx.SourceA, 'dist/skip.todl': 'garbage' })
    public readonly B = new MemoryStorage(EngineHostFx.RootB, { [EngineHostFx.File]: EngineHostFx.SourceB })
    public readonly Lang = new FakeLanguageService()
    public Solution: IDevSolution | undefined = new FakeSolution(EngineHostFx.SolutionName, [{ Storage: this.A }, { Storage: this.B }, {}])

    public readonly Source = (): Promise<IDevSolution | undefined> => Promise.resolve(this.Solution)

    /** One member `mem/s` whose single file declares both shop.M (c1 Ada) and shop.N (c2 Bo). */
    public static readonly SharedFile = 'two.todl'
    public static readonly Shared = 'namespace shop {\n  model M : shop {\n    Customer c1 { name = "Ada"; }\n  }\n  model N : shop {\n    Customer c2 { name = "Bo"; }\n  }\n}\n'

    /** Replaces the solution with one member holding both models in {@link EngineHostFx.SharedFile}. */
    public ShareOneFile(): MemoryStorage
    {
        const shared = new MemoryStorage('mem/s', { [EngineHostFx.SharedFile]: EngineHostFx.Shared })
        this.Solution = new FakeSolution(EngineHostFx.SolutionName, [{ Storage: shared }])
        return shared
    }

    public static SchemaDocument(): TodlDocument
    {
        return toJSON(checkAgainst([], [{ uri: 'schema.todl', text: EngineHostFx.Schema }]).model)
    }
}
