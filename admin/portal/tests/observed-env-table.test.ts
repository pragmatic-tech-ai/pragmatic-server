import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { ObservedEnvTable } from '../src/observed-env-table.js'
import { DataTable } from '../src/kit/index.js'

describe('ObservedEnvTable', () =>
{
    let previous: Application | null

    before(() =>
    {
        previous = Application.current
        const app = new Application()
        Application.current = app
        app.initialize({ theme: Pragmatic, scheme: PragmaticLight })
    })

    after(() =>
    {
        Application.current = previous
    })

    it('builds a row per observed environment', () =>
    {
        const table = ObservedEnvTable.Build([
            { name: 'prod', ready: true, image: 'img:1', detail: 'ok' },
            { name: 'stg', ready: false, image: '-', detail: 'down' },
        ])
        assert.ok(table instanceof DataTable)
        assert.equal(table.Rows.length, 2)
    })

    it('builds an empty table without throwing', () =>
    {
        const table = ObservedEnvTable.Build([])
        assert.ok(table instanceof DataTable)
        assert.equal(table.Rows.length, 0)
    })
})
