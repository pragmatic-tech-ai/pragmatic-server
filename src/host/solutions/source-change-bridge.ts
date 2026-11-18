import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { StorageChangedPayload } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { TodlSourceCollector } from '../model/todl-source-collector.js'

/**
 * Turns a committed remote source mutation into (1) the shared language service's `DidChange` for text writes, so its
 * existing GraphChanged/BuildStateChanged fan-out reaches every client, and (2) a {@link Changed} signal that each
 * connection forwards as `storage/changed`. The server is authoritative: a client save never drives DidChange itself.
 * One bridge per environment, bound to its shared language service; it signals upward and knows nothing of connections.
 */
export class SourceChangeBridge
{
    private static readonly Added: StorageChangedPayload['Kind'] = 'added'
    private static readonly Removed: StorageChangedPayload['Kind'] = 'removed'
    private static readonly ChangedKind: StorageChangedPayload['Kind'] = 'changed'

    /** Emits one payload per committed mutation (a rename emits removed then added). */
    public readonly Changed = new Signal<StorageChangedPayload>()

    public constructor(private readonly languageService: ILanguageService)
    {
    }

    /** A text file was written: announce it, then (for tracked `.todl` sources only) feed the shared document model. `existed` picks added vs changed. */
    public TextWritten(storage: IStorage, path: string, text: string, existed: boolean): void
    {
        this.Emit(existed ? SourceChangeBridge.ChangedKind : SourceChangeBridge.Added, path, false)
        if (TodlSourceCollector.IsSourcePath(path))
        {
            this.DriveDidChange(storage, path, text)
        }
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

    /** The write is already committed, so a language-service failure must never fail it or suppress the push already emitted. */
    private DriveDidChange(storage: IStorage, path: string, text: string): void
    {
        try
        {
            this.languageService.DidChange(TodlSourceCollector.AbsoluteUri(storage, path), text)
        }
        catch
        {
            // best effort: the next save or reload resynchronizes the document model
        }
    }

    private Emit(kind: StorageChangedPayload['Kind'], path: string, isDirectory: boolean): void
    {
        this.Changed.emit({ Kind: kind, Path: path, IsDirectory: isDirectory })
    }
}
