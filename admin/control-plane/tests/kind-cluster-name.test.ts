import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KindClusterName, InvalidHiveClusterNameError } from '../kind-cluster-name.js'

class KindClusterNameFixtures
{
    public static readonly ValidHiveId = 'acme1'
    public static readonly ExpectedClusterName = 'pragmatic-hive-acme1'
    public static readonly ExpectedContextName = 'kind-pragmatic-hive-acme1'
    public static readonly InvalidHiveIds: readonly string[] = ['', 'Acme', 'my_hive', 'a.b', 'äcme', 'a'.repeat(60)]
}

describe('KindClusterName', () =>
{
    it('For composes pragmatic-hive-<id> for a valid id', () =>
    {
        assert.equal(KindClusterName.For(KindClusterNameFixtures.ValidHiveId), KindClusterNameFixtures.ExpectedClusterName)
    })

    it('ContextFor prefixes kind-', () =>
    {
        assert.equal(KindClusterName.ContextFor(KindClusterNameFixtures.ExpectedClusterName), KindClusterNameFixtures.ExpectedContextName)
    })

    it('For rejects empty, uppercase, underscore, dot, non-ascii, and over-length ids', () =>
    {
        for (const hiveId of KindClusterNameFixtures.InvalidHiveIds)
        {
            assert.throws(() => KindClusterName.For(hiveId), InvalidHiveClusterNameError)
        }
    })
})
