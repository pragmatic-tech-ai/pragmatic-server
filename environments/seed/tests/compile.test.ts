import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NorthwindApp } from '../compile.js'

test('Northwind compiles to a model.json and its orders are queryable', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'nw-'))
    await NorthwindApp.Compile(dir)
    assert.ok(existsSync(join(dir, 'northwind', '1.0.0', 'model.json')))
    const rows = await NorthwindApp.QueryOrderCount(dir)
    assert.equal(rows, 8)
})
