import { readFile } from 'node:fs/promises'
import { AtomicJsonFile, type AtomicWriteOptions } from './atomic-json-file.js'

/**
 * Where a store keeps its records: a map of JSON records by key. `Load` answers every stored record; `Save` persists the
 * keys a change touched (a key present in `all` is written with its record, an absent one is removed). The file form
 * rewrites the whole map from `all` (one atomic file); the Postgres form writes only the changed rows. Stores keep their
 * records in memory and use the map for durability only, so their reads stay synchronous.
 */
export interface IRecordMap<T>
{
    /** Where the records live, for error messages (a file path or a table name; never a secret). */
    readonly Location: string
    Load(): Promise<ReadonlyMap<string, T>>
    Save(all: ReadonlyMap<string, T>, changed: ReadonlySet<string>): Promise<void>
}

/** A record map whose stored form cannot be read: not JSON, not an object of records, or without its required root. */
export class RecordMapFormatError extends Error
{
    private static readonly ErrorName = 'RecordMapFormatError'
    private static readonly MessagePrefix = 'The stored records cannot be read: '

    public constructor(public readonly Location: string)
    {
        super(RecordMapFormatError.MessagePrefix + Location)
        this.name = RecordMapFormatError.ErrorName
    }
}

/** How a FileRecordMap lays out and writes its file. */
export interface FileRecordMapOptions
{
    /** The records sit under this key (`{ <root>: { <key>: record } }`); omitted, the file IS the map. */
    readonly RootKey?: string
    /** A file without the root key is unreadable instead of empty. */
    readonly RequireRoot?: boolean
    /** JSON.stringify indent (default 2). */
    readonly Indent?: number
    /** The temp file's mode and fsync (see AtomicJsonFile). */
    readonly Write?: AtomicWriteOptions
    /** Replaces the write primitive (a test holding or observing a write); default AtomicJsonFile.WriteText. */
    readonly WriteText?: (path: string, text: string) => Promise<void>
}

/**
 * The JSON file form of a record map (the control plane's data-root layout): a missing file is empty; the whole map is
 * written atomically (unique temp file, then rename) on every Save.
 */
export class FileRecordMap<T> implements IRecordMap<T>
{
    private static readonly Encoding = 'utf8'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly DefaultIndent = 2

    public constructor(private readonly filePath: string, private readonly options: FileRecordMapOptions = {})
    {
    }

    public get Location(): string
    {
        return this.filePath
    }

    public async Load(): Promise<ReadonlyMap<string, T>>
    {
        let text: string
        try
        {
            text = await readFile(this.filePath, FileRecordMap.Encoding)
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code === FileRecordMap.NotFoundCode)
            {
                return new Map()
            }
            throw err
        }
        let parsed: unknown
        try
        {
            parsed = JSON.parse(text)
        }
        catch
        {
            throw new RecordMapFormatError(this.filePath)
        }
        const root = this.RootOf(parsed)
        return new Map(Object.entries(root) as Array<[string, T]>)
    }

    public async Save(all: ReadonlyMap<string, T>, _changed: ReadonlySet<string>): Promise<void>
    {
        const map = Object.fromEntries(all)
        const body = this.options.RootKey === undefined ? map : { [this.options.RootKey]: map }
        const indent = this.options.Indent ?? FileRecordMap.DefaultIndent
        if (this.options.WriteText !== undefined)
        {
            await this.options.WriteText(this.filePath, JSON.stringify(body, null, indent))
            return
        }
        await AtomicJsonFile.Write(this.filePath, body, indent, this.options.Write)
    }

    private RootOf(parsed: unknown): Record<string, unknown>
    {
        if (!FileRecordMap.IsObject(parsed))
        {
            throw new RecordMapFormatError(this.filePath)
        }
        if (this.options.RootKey === undefined)
        {
            return parsed
        }
        const root = parsed[this.options.RootKey]
        if (root === undefined && this.options.RequireRoot !== true)
        {
            return {}
        }
        if (!FileRecordMap.IsObject(root))
        {
            throw new RecordMapFormatError(this.filePath)
        }
        return root
    }

    private static IsObject(value: unknown): value is Record<string, unknown>
    {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
    }
}

/** A process-local record map, for tests and tools that keep nothing. */
export class MemoryRecordMap<T> implements IRecordMap<T>
{
    private static readonly MemoryLocation = '(memory)'

    private records = new Map<string, T>()

    public get Location(): string
    {
        return MemoryRecordMap.MemoryLocation
    }

    public async Load(): Promise<ReadonlyMap<string, T>>
    {
        return new Map([...this.records].map(([key, record]) => [key, structuredClone(record)]))
    }

    public async Save(all: ReadonlyMap<string, T>, changed: ReadonlySet<string>): Promise<void>
    {
        for (const key of changed)
        {
            const record = all.get(key)
            if (record === undefined)
            {
                this.records.delete(key)
            }
            else
            {
                this.records.set(key, structuredClone(record))
            }
        }
    }
}
