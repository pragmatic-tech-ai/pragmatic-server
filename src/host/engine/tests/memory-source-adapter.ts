import { DataSourceKind, QueryFilterEvaluator, WriteConcurrency, WriteFailureKind, WriteOperationKind } from '@pragmatic-tech-ai/todl'
import type { ExternalFieldValue, ExternalRecord, IDataSourceAdapter, IDataSourceAdapterFactory, PageQuery, PageSlice, QueryRequest, ResolvedConnection, WriteBatch, WriteFailure, WriteResult } from '@pragmatic-tech-ai/todl'

/** One version a write reported (`WriteResult.Versions` entry). */
type ReportedVersion = { Key: ExternalFieldValue; Version: ExternalFieldValue }

/**
 * A test-only external data source held in memory, as a SQL adapter behaves: `Query` filters by the pushed `Where`
 * (SQL null semantics, TODL's QueryFilterEvaluator) and projects `Fields`; `QueryPage` serves keyset pages by
 * `OrderKey` (else `Fields[0]`) when `CanPage` is set; `Apply` upserts (replacing the row) and deletes by `IdKey`, an
 * Optimistic upsert of an existing row whose stored `VersionField` differs from the op's `Version` is a conflict.
 * Every read is logged in `Requests` and every batch in `Batches`, so a test sees exactly what reached the source
 * (nothing is cached across queries). `IgnoreWhere` answers every read as if no Where were given (a source that
 * ignores the pushed predicate); `FailNext(kind)` makes the next Apply apply nothing and report each of its operations
 * as a failure of `kind`. `BumpVersions` makes an applied Optimistic upsert store the next version (the stored one plus
 * one) and report it in `WriteResult.Versions`, as a source that versions its rows does.
 */
export class MemorySourceAdapter implements IDataSourceAdapter
{
    private static readonly FailedReason = 'simulated source failure'
    private static readonly StaleReason = 'stale version'

    public readonly Requests: QueryRequest[] = []
    public readonly Batches: WriteBatch[] = []
    public CanPage = false
    public IgnoreWhere = false
    public BumpVersions = false
    private readonly sources = new Map<string, ExternalRecord[]>()
    private failNext: WriteFailureKind | undefined

    /** Replaces the rows of `source`. */
    public Seed(source: string, records: readonly ExternalRecord[]): this
    {
        this.sources.set(source, records.map(record => ({ ...record })))
        return this
    }

    /** The rows `source` holds now (copies). */
    public Rows(source: string): ExternalRecord[]
    {
        return (this.sources.get(source) ?? []).map(record => ({ ...record }))
    }

    /** The next Apply applies nothing and reports each operation as a failure of `kind` (once). */
    public FailNext(kind: WriteFailureKind): this
    {
        this.failNext = kind
        return this
    }

    public async Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        this.Requests.push(request)
        return this.Matching(request)
    }

    public async QueryPage(request: QueryRequest, page: PageQuery): Promise<PageSlice>
    {
        this.Requests.push(request)
        const key = request.OrderKey ?? request.Fields[0]!
        const rows = this.Matching(request)
            .sort((a, b) => MemorySourceAdapter.Order(a[key] ?? null, b[key] ?? null))
            .filter(row => page.After === undefined || MemorySourceAdapter.Order(row[key] ?? null, page.After) > 0)
        const records = rows.slice(0, page.Limit)
        return records.length === page.Limit && records.length > 0
            ? { Records: records, NextAfter: records[records.length - 1]![key] ?? null }
            : { Records: records }
    }

    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        this.Batches.push(batch)
        const failing = this.failNext
        if (failing !== undefined)
        {
            this.failNext = undefined
            return { Applied: 0, Failures: batch.Operations.map(op => ({ Key: op.Key, Kind: failing, Reason: MemorySourceAdapter.FailedReason })) }
        }
        const rows = this.sources.get(batch.Source) ?? []
        this.sources.set(batch.Source, rows)
        const failures: WriteFailure[] = []
        const versions: ReportedVersion[] = []
        let applied = 0
        for (const op of batch.Operations)
        {
            const index = rows.findIndex(row => row[batch.IdKey] === op.Key)
            if (op.Kind === WriteOperationKind.Delete)
            {
                if (index >= 0)
                {
                    rows.splice(index, 1)
                    applied++
                }
                continue
            }
            if (batch.Concurrency === WriteConcurrency.Optimistic && batch.VersionField !== undefined && index >= 0)
            {
                const stored = rows[index]![batch.VersionField] ?? null
                if (stored === null || stored !== (op.Version ?? null))
                {
                    failures.push({ Key: op.Key, Kind: WriteFailureKind.Conflict, Reason: MemorySourceAdapter.StaleReason })
                    continue
                }
            }
            const row: { [field: string]: ExternalFieldValue } = { ...op.Fields, [batch.IdKey]: op.Key }
            if (this.BumpVersions && batch.Concurrency === WriteConcurrency.Optimistic && batch.VersionField !== undefined)
            {
                const next = Number(index >= 0 ? rows[index]![batch.VersionField] ?? 0 : 0) + 1
                row[batch.VersionField] = next
                versions.push({ Key: op.Key, Version: next })
            }
            if (index >= 0) rows[index] = row
            else rows.push(row)
            applied++
        }
        return versions.length === 0 ? { Applied: applied, Failures: failures } : { Applied: applied, Failures: failures, Versions: versions }
    }

    public async Dispose(): Promise<void>
    {
    }

    private Matching(request: QueryRequest): ExternalRecord[]
    {
        const where = this.IgnoreWhere ? undefined : request.Where
        return (this.sources.get(request.Source) ?? [])
            .filter(row => QueryFilterEvaluator.Matches(row, where))
            .map(row => MemorySourceAdapter.Project(row, request.Fields))
    }

    private static Project(row: ExternalRecord, fields: readonly string[]): ExternalRecord
    {
        const projected: { [field: string]: ExternalFieldValue } = {}
        for (const field of fields)
        {
            if (field in row) projected[field] = row[field] ?? null
        }
        return projected
    }

    private static Order(a: ExternalFieldValue, b: ExternalFieldValue): number
    {
        if (a === b) return 0
        return (a ?? '') < (b ?? '') ? -1 : 1
    }
}

/**
 * Hands out one {@link MemorySourceAdapter} for the SQL kind (register it with `DataSourceAdapterCatalog.Register`).
 * While `OpenFailure` is set every Open rejects with it (an unreachable or misconfigured source).
 */
export class MemorySourceAdapterFactory implements IDataSourceAdapterFactory
{
    public readonly Kind = DataSourceKind.Sql
    public readonly Opened: ResolvedConnection[] = []
    public OpenFailure: Error | undefined

    public constructor(public readonly Adapter: MemorySourceAdapter = new MemorySourceAdapter())
    {
    }

    public async Open(connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        if (this.OpenFailure !== undefined) throw this.OpenFailure
        this.Opened.push(connection)
        return this.Adapter
    }
}
