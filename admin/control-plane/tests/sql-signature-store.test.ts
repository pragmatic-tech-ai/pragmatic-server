import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { SqlSignatureStore } from '../sql-signature-store.js'
import { SqlRecordMap } from '../sql-record-map.js'

class SqlSignatureFixture
{
    public static readonly Digest = 'sha256:abc123'
    public static readonly Signature = 'c2lnbmF0dXJl'
    public static readonly OtherSignature = 'b3RoZXI='
    public static readonly KeyRef = 'platform-signing'
    public static readonly OtherKeyRef = 'acme'
}

describe('SqlSignatureStore', () =>
{
    const F = SqlSignatureFixture
    SqlTestSessions.Describe('SqlSignatureStore', (makeSession, backend) =>
    {
        it(`${backend}: round-trips a Put then Get, and an unknown digest or key is undefined`, async () =>
        {
            const store = await SqlSignatureStore.Open(await makeSession())
            await store.Put(F.Digest, F.KeyRef, F.Signature)
            assert.equal(await store.Get(F.Digest, F.KeyRef), F.Signature)
            assert.equal(await store.Get(F.Digest, F.OtherKeyRef), undefined)
            assert.equal(await store.Get('sha256:none', F.KeyRef), undefined)
        })

        it(`${backend}: two keys signing one digest keep both, each reported keyed`, async () =>
        {
            const store = await SqlSignatureStore.Open(await makeSession())
            await Promise.all([store.Put(F.Digest, F.KeyRef, F.Signature), store.Put(F.Digest, F.OtherKeyRef, F.OtherSignature)])
            assert.equal(await store.Get(F.Digest, F.KeyRef), F.Signature)
            assert.equal(await store.Get(F.Digest, F.OtherKeyRef), F.OtherSignature)
            assert.equal(await store.HasKeyed(F.Digest, F.KeyRef), true)
            assert.equal(await store.HasKeyed(F.Digest, F.OtherKeyRef), true)
        })

        it(`${backend}: an imported pre-keyed signature answers any key ref but never counts as keyed`, async () =>
        {
            const session = await makeSession()
            const store = await SqlSignatureStore.Open(session)
            const rows = await SqlRecordMap.Open<Record<string, string>>(session, SqlSignatureStore.Registry)
            await rows.Save(new Map([[F.Digest, SqlSignatureStore.RecordOf(F.Signature)]]), new Set([F.Digest]))
            assert.equal(await store.Get(F.Digest, F.KeyRef), F.Signature)
            assert.equal(await store.HasKeyed(F.Digest, F.KeyRef), false)
            assert.equal(await store.HasKeyed(F.Digest, SqlSignatureStore.LegacyKeyRef), false)
            await store.Put(F.Digest, F.KeyRef, F.OtherSignature)
            assert.equal(await store.Get(F.Digest, F.KeyRef), F.OtherSignature)
            assert.equal(await store.Get(F.Digest, F.OtherKeyRef), F.Signature)
            assert.equal(await store.HasKeyed(F.Digest, F.KeyRef), true)
        })

        it(`${backend}: a second instance on the same database sees the first one's signatures`, async () =>
        {
            const session = await makeSession()
            await (await SqlSignatureStore.Open(session)).Put(F.Digest, F.KeyRef, F.Signature)
            assert.equal(await (await SqlSignatureStore.Open(session)).Get(F.Digest, F.KeyRef), F.Signature)
        })
    })
})
