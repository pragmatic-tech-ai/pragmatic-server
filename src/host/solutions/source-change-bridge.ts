import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { StorageChangedPayload } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { TodlSourceCollector } from '../model/todl-source-collector.js'

/**
 * Turns a committed remote source mutation into (1) the shared language service's `DidChange` for text writes, so its
 * existing GraphChanged/BuildStateChanged fan-out reaches every client, and (2) a {@link Changed} signal that each
 * connection forwards as `storage/changed`. The server is authoritative: a client save never drives DidChange itself.
 * One bridge per shared language service ({@link For}); it signals upward and knows nothing of connections.
 */
export class SourceChangeBridge
{
    private static readonly Bridges = new WeakMap<ILanguageService, SourceChangeBridge>()
    private static readonly Added = 'added'
    private static readonly Removed = 'removed'
    private static readonly ChangedKind = 'changed'

    /** Emits one payload per committed mutation (a rename emits removed then added). */
    public readonly Changed = new Signal<StorageChangedPayload>()

    public constructor(private readonly languageService: ILanguageService)
    {
    }

    /** The bridge shared by every connection over this language service. */
    public static For(languageService: ILanguageService): SourceChangeBridge
    {
        let bridge = SourceChangeBridge.Bridges.get(languageService)
        if (bridge === undefined)
        {
            bridge = new SourceChangeBridge(languageService)
            SourceChangeBridge.Bridges.set(languageService, bridge)
        }
        return bridge
    }

    /** A text file was written: feed the shared document model, then announce it. `existed` picks added vs changed. */
    public TextWritten(storage: IStorage, path: string, text: string, existed: boolean): void
    {
        this.languageService.DidChange(TodlSourceCollector.AbsoluteUri(storage, path), text)
        this.Emit(existed ? SourceChangeBridge.ChangedKind : SourceChangeBridge.Added, path, false)
    }

    /** A binary file was written: announced only (not a text-document edit). */
    public BytesWritten(path: string, existed: boolean): void
    {
        this.Emit(existed ? SourceChangeBridge.ChangedKind : SourceChangeBridge.Added, path, false)
    }

    public Deleted(path: string, isDirectory: boolean): void
    {
        this.Emit(SourceChangeBridge.Removed, path, isDirectory)
    }

    public DirectoryCreated(path: string): void
    {
        this.Emit(SourceChangeBridge.Added, path, true)
    }

    public Renamed(from: string, to: string, isDirectory: boolean): void
    {
        this.Emit(SourceChangeBridge.Removed, from, isDirectory)
        this.Emit(SourceChangeBridge.Added, to, isDirectory)
    }

    private Emit(kind: string, path: string, isDirectory: boolean): void
    {
        this.Changed.emit({ Kind: kind, Path: path, IsDirectory: isDirectory } as StorageChangedPayload)
    }
}
