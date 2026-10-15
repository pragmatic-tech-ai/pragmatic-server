import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import type { IDocumentSession } from '@pragmatic-tech-ai/todl-connectors-host'
import { StorageDocumentSession } from '../storage-document-session.js'
import { SqliteDocumentSession } from '../sqlite-document-session.js'

class DocumentSessionConformance
{
    private static readonly Prefix = 'docsession-'
    private static readonly DbFile = 'store.db'
    private static readonly Collection = 'Customer'
    private static readonly IdField = 'id'
    private static readonly Empty: Record<string, unknown> = {}

    public static async RunAll(make: (dir: string) => IDocumentSession): Promise<void>
    {
        const cases = [
            DocumentSessionConformance.Crud,
            DocumentSessionConformance.UpdateNotDuplicate,
            DocumentSessionConformance.DeleteMissing,
            DocumentSessionConformance.EmptyCollection,
            DocumentSessionConformance.TypeRoundTrip,
            DocumentSessionConformance.PathSafety
        ]
        for (const run of cases)
        {
            const dir = mkdtempSync(join(tmpdir(), DocumentSessionConformance.Prefix))
            const session = make(dir)
            try
            {
                await run(session)
            }
            finally
            {
                await session.Dispose?.()
                rmSync(dir, { recursive: true, force: true })
            }
        }
    }

    public static MakeStorage(dir: string): IDocumentSession
    {
        return new StorageDocumentSession(new NodeFsStorage(dir))
    }

    public static MakeSqlite(dir: string): IDocumentSession
    {
        return new SqliteDocumentSession(join(dir, DocumentSessionConformance.DbFile))
    }

    public static async Durability(): Promise<void>
    {
        const dir = mkdtempSync(join(tmpdir(), DocumentSessionConformance.Prefix))
        try
        {
            const first = DocumentSessionConformance.MakeSqlite(dir)
            await first.Upsert(DocumentSessionConformance.Collection, DocumentSessionConformance.IdField, 'a', { name: 'Ann' })
            await first.Dispose?.()
            const second = DocumentSessionConformance.MakeSqlite(dir)
            const docs = await second.Find(DocumentSessionConformance.Collection, DocumentSessionConformance.Empty)
            await second.Dispose?.()
            assert.deepEqual(docs, [{ name: 'Ann', id: 'a' }])
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    public static async OpenRace(): Promise<void>
    {
        const dir = mkdtempSync(join(tmpdir(), DocumentSessionConformance.Prefix))
        try
        {
            const c = DocumentSessionConformance.Collection
            const f = DocumentSessionConformance.IdField
            const session = DocumentSessionConformance.MakeSqlite(dir)
            const [found] = await Promise.all([
                session.Find(c, DocumentSessionConformance.Empty),
                session.Upsert(c, f, 'k', { name: 'K' })
            ])
            assert.ok(found.length <= 1)
            assert.deepEqual(await session.Find(c, DocumentSessionConformance.Empty), [{ name: 'K', id: 'k' }])
            await session.Dispose?.()
            const again = DocumentSessionConformance.MakeSqlite(dir)
            assert.deepEqual(await again.Find(c, DocumentSessionConformance.Empty), [{ name: 'K', id: 'k' }])
            await again.Dispose?.()
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    public static async FailedOpenRetry(): Promise<void>
    {
        const dir = mkdtempSync(join(tmpdir(), DocumentSessionConformance.Prefix))
        try
        {
            const c = DocumentSessionConformance.Collection
            const missing = join(dir, 'missing')
            const session = new SqliteDocumentSession(join(missing, DocumentSessionConformance.DbFile))
            await assert.rejects(session.Find(c, DocumentSessionConformance.Empty))
            await assert.rejects(session.Find(c, DocumentSessionConformance.Empty))
            mkdirSync(missing)
            assert.deepEqual(await session.Find(c, DocumentSessionConformance.Empty), [])
            await session.Dispose?.()
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    private static async PathSafety(s: IDocumentSession): Promise<void>
    {
        const f = DocumentSessionConformance.IdField
        const cols = ['..', 'a.b.C']
        const keys = ['a*b', 'A', 'a']
        for (const c of cols)
        {
            for (const k of keys)
            {
                await s.Upsert(c, f, k, { v: `${c}|${k}` })
            }
        }
        for (const c of cols)
        {
            const docs = [...(await s.Find(c, DocumentSessionConformance.Empty))].map(d => String(d.v)).sort()
            assert.deepEqual(docs, keys.map(k => `${c}|${k}`).sort())
        }
        assert.equal(await s.Delete('..', f, 'A'), true)
        assert.equal((await s.Find('..', DocumentSessionConformance.Empty)).length, 2)
        assert.equal((await s.Find('a.b.C', DocumentSessionConformance.Empty)).length, 3)
    }

    private static async Crud(s: IDocumentSession): Promise<void>
    {
        const c = DocumentSessionConformance.Collection
        const f = DocumentSessionConformance.IdField
        await s.Upsert(c, f, 'a', { name: 'Ann' })
        await s.Upsert(c, f, 'b', { name: 'Bob' })
        const docs = [...(await s.Find(c, DocumentSessionConformance.Empty))].sort((x, y) => String(x[f]).localeCompare(String(y[f])))
        assert.deepEqual(docs, [{ name: 'Ann', id: 'a' }, { name: 'Bob', id: 'b' }])
        assert.equal(await s.Delete(c, f, 'a'), true)
        assert.deepEqual(await s.Find(c, DocumentSessionConformance.Empty), [{ name: 'Bob', id: 'b' }])
    }

    private static async UpdateNotDuplicate(s: IDocumentSession): Promise<void>
    {
        const c = DocumentSessionConformance.Collection
        const f = DocumentSessionConformance.IdField
        await s.Upsert(c, f, 'a', { name: 'Ann' })
        await s.Upsert(c, f, 'a', { name: 'Anna' })
        assert.deepEqual(await s.Find(c, DocumentSessionConformance.Empty), [{ name: 'Anna', id: 'a' }])
    }

    private static async DeleteMissing(s: IDocumentSession): Promise<void>
    {
        assert.equal(await s.Delete(DocumentSessionConformance.Collection, DocumentSessionConformance.IdField, 'nope'), false)
    }

    private static async EmptyCollection(s: IDocumentSession): Promise<void>
    {
        assert.deepEqual(await s.Find('Unknown/Thing', DocumentSessionConformance.Empty), [])
    }

    private static async TypeRoundTrip(s: IDocumentSession): Promise<void>
    {
        const c = DocumentSessionConformance.Collection
        const f = DocumentSessionConformance.IdField
        await s.Upsert(c, f, 'we/ird key', { s: 'x', n: 42, b: true, a: [1, 'two', false] })
        const [doc] = await s.Find(c, DocumentSessionConformance.Empty)
        assert.equal(typeof doc.s, 'string')
        assert.equal(doc.n, 42)
        assert.equal(doc.b, true)
        assert.deepEqual(doc.a, [1, 'two', false])
        assert.equal(doc[f], 'we/ird key')
    }
}

test('StorageDocumentSession conformance', async () =>
{
    await DocumentSessionConformance.RunAll(DocumentSessionConformance.MakeStorage)
})

test('SqliteDocumentSession conformance', async () =>
{
    await DocumentSessionConformance.RunAll(DocumentSessionConformance.MakeSqlite)
})

test('SqliteDocumentSession durability across dispose and reopen', async () =>
{
    await DocumentSessionConformance.Durability()
})

test('SqliteDocumentSession concurrent first calls open once', async () =>
{
    await DocumentSessionConformance.OpenRace()
})

test('SqliteDocumentSession failed open is retryable', async () =>
{
    await DocumentSessionConformance.FailedOpenRetry()
})
