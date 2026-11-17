import { ResponseError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { StoragePathParams, StorageTextDto, StorageBytesDto, StorageWriteTextParams, StorageWriteBytesParams, StorageRenameParams, StorageEntryDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { InvalidParamsPrefix } from '../invalid-params-prefix.js'

/**
 * Maps each `StorageProtocol` request onto the environment's source `IStorage`. Every path is resolved relative to
 * the storage root; an absolute path or one that normalizes outside the root is rejected before storage is touched.
 */
export class RemoteStorageHandlers
{
    private static readonly NoStorageMessage = 'no active solution source storage'
    private static readonly EscapeMessage = `${InvalidParamsPrefix.Text}path must be relative and stay inside the source root: `
    private static readonly Base64 = 'base64'
    private static readonly SeparatorPattern = /[\\/]/
    private static readonly DriveLetterPattern = /^[A-Za-z]:/
    private static readonly Separator = '/'
    private static readonly CurrentSegment = '.'
    private static readonly ParentSegment = '..'

    public constructor(private readonly storage: () => IStorage | undefined)
    {
    }

    public async ReadText(params: StoragePathParams): Promise<StorageTextDto>
    {
        return { Content: await this.Store().ReadText(RemoteStorageHandlers.Resolve(params.Path)) }
    }

    public async ReadBytes(params: StoragePathParams): Promise<StorageBytesDto>
    {
        const bytes = await this.Store().ReadBytes(RemoteStorageHandlers.Resolve(params.Path))
        return { BytesBase64: Buffer.from(bytes).toString(RemoteStorageHandlers.Base64) }
    }

    public async WriteText(params: StorageWriteTextParams): Promise<void>
    {
        return this.Store().WriteText(RemoteStorageHandlers.Resolve(params.Path), params.Content)
    }

    public async WriteBytes(params: StorageWriteBytesParams): Promise<void>
    {
        const bytes = new Uint8Array(Buffer.from(params.BytesBase64, RemoteStorageHandlers.Base64))
        return this.Store().WriteBytes(RemoteStorageHandlers.Resolve(params.Path), bytes)
    }

    public async Exists(params: StoragePathParams): Promise<boolean>
    {
        return this.Store().Exists(RemoteStorageHandlers.Resolve(params.Path))
    }

    public async Delete(params: StoragePathParams): Promise<void>
    {
        return this.Store().Delete(RemoteStorageHandlers.Resolve(params.Path))
    }

    public async CreateDirectory(params: StoragePathParams): Promise<void>
    {
        return this.Store().CreateDirectory(RemoteStorageHandlers.Resolve(params.Path))
    }

    public async Rename(params: StorageRenameParams): Promise<void>
    {
        return this.Store().Rename(RemoteStorageHandlers.Resolve(params.From), RemoteStorageHandlers.Resolve(params.To))
    }

    public async List(params: StoragePathParams): Promise<StorageEntryDto[]>
    {
        const entries = await this.Store().List(RemoteStorageHandlers.Resolve(params.Path))
        return entries.map(entry => ({ Name: entry.Name, IsDirectory: entry.IsDirectory }))
    }

    private Store(): IStorage
    {
        const storage = this.storage()
        if (storage === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, RemoteStorageHandlers.NoStorageMessage)
        }
        return storage
    }

    /** The normalized root-relative path ('' is the root); throws InvalidParams for an absolute path or one that climbs out of the root. */
    private static Resolve(path: string): string
    {
        if (typeof path !== 'string' || RemoteStorageHandlers.IsAbsolute(path))
        {
            throw new ResponseError(ErrorCodes.InvalidParams, RemoteStorageHandlers.EscapeMessage + String(path))
        }
        const kept: string[] = []
        for (const segment of path.split(RemoteStorageHandlers.SeparatorPattern))
        {
            if (segment === '' || segment === RemoteStorageHandlers.CurrentSegment)
            {
                continue
            }
            if (segment === RemoteStorageHandlers.ParentSegment)
            {
                if (kept.pop() === undefined)
                {
                    throw new ResponseError(ErrorCodes.InvalidParams, RemoteStorageHandlers.EscapeMessage + path)
                }
                continue
            }
            kept.push(segment)
        }
        return kept.join(RemoteStorageHandlers.Separator)
    }

    private static IsAbsolute(path: string): boolean
    {
        return RemoteStorageHandlers.SeparatorPattern.test(path.charAt(0)) || RemoteStorageHandlers.DriveLetterPattern.test(path)
    }
}
