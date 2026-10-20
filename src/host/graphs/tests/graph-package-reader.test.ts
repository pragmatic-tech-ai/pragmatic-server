import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import { GraphPackageMissingError, GraphPackageReader } from '../graph-package-reader.js'

test('ReadAll returns id, version and modelJson for present blobs', async () =>
{
    const storage = new FakeStorage()
    await storage.WriteText('a/1/model.json', '{"a":1}')
    await storage.WriteText('b/2/model.json', '{"b":2}')
    const result = await new GraphPackageReader(storage).ReadAll([{ id: 'a', version: '1' }, { id: 'b', version: '2' }])
    assert.deepEqual(result, [{ id: 'a', version: '1', modelJson: '{"a":1}' }, { id: 'b', version: '2', modelJson: '{"b":2}' }])
})

test('export_missing_blob_throws_named', async () =>
{
    const storage = new FakeStorage()
    await storage.WriteText('a/1/model.json', '{}')
    await assert.rejects(
        new GraphPackageReader(storage).ReadAll([{ id: 'a', version: '1' }, { id: 'ghost', version: '9.9' }]),
        (e: Error) => e instanceof GraphPackageMissingError && e.message.includes('ghost') && e.message.includes('9.9'))
})
