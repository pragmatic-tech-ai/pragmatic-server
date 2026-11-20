import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PgSession } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { MemoryRecordMap, RecordMapFormatError, RecordSlot } from '../record-map.js'
import { SqlRecordMap } from '../sql-record-map.js'

class RecordSlotFixture
{
    public static readonly Prefix = 'recordslot-'
    public static readonly FileName = 'state.json'
    public static readonly Key = 'state'
    public static readonly Registry = 'slot_things'
    public static readonly Encoding = 'utf8'
    public static readonly Dirs: string[] = []

    public static async TempFile(): Promise<string>
    {
        const dir = await mkdtemp(join(tmpdir(), RecordSlotFixture.Prefix))
        RecordSlotFixture.Dirs.push(dir)
        return join(dir, RecordSlotFixture.FileName)
    }
}

describe('RecordSlot', () =>
{
    const F = RecordSlotFixture
    after(async () =>
    {
        for (const dir of F.Dirs)
        {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('reads nothing from an empty map and what was written afterwards', async () =>
    {
        const slot = RecordSlot.Of<string[]>(new MemoryRecordMap<string[]>(), F.Key)
        assert.equal(await slot.Read(), undefined)
        await slot.Write(['a.example', 'b.example'])
        assert.deepEqual(await slot.Read(), ['a.example', 'b.example'])
    })

    it('over a file path keeps the pre-A5 layout: the file is `{ <key>: value }`', async () =>
    {
        const path = await F.TempFile()
        await writeFile(path, JSON.stringify({ state: 'refused' }), F.Encoding)
        const slot = RecordSlot.Of<string>(path, F.Key)
        assert.equal(await slot.Read(), 'refused')
        await slot.Write('registered')
        assert.deepEqual(JSON.parse(await readFile(path, F.Encoding)), { state: 'registered' })
        assert.equal(slot.Location, path)
    })

    it('a missing file reads nothing; a file that is not an object of records is a format error', async () =>
    {
        const missing = RecordSlot.Of<string>(join(await mkdtemp(join(tmpdir(), F.Prefix)), F.FileName), F.Key)
        assert.equal(await missing.Read(), undefined)
        const path = await F.TempFile()
        await writeFile(path, '[1]', F.Encoding)
        await assert.rejects(RecordSlot.Of<string>(path, F.Key).Read(), RecordMapFormatError)
    })

    it('over a Postgres table (pg-mem) the value survives a reopen', async () =>
    {
        const session = new PgSession(SqlTestSessions.MemPool())
        const slot = RecordSlot.Of<{ appliedAt: string }>(await SqlRecordMap.Open(session, F.Registry), F.Key)
        await slot.Write({ appliedAt: '2026-11-20T10:00:00.000Z' })
        const reopened = RecordSlot.Of<{ appliedAt: string }>(await SqlRecordMap.Open(session, F.Registry), F.Key)
        assert.deepEqual(await reopened.Read(), { appliedAt: '2026-11-20T10:00:00.000Z' })
    })
})
