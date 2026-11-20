import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PragmaticPostgresComponent } from '../../postgres/pragmatic-postgres-component.js'
import { ComponentGolden } from '../../../src/component/tests/component-golden.js'
import { ComponentSources } from '../../../src/component/tests/component-sources.js'

class PragmaticPostgresComponentFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Golden = join(PragmaticPostgresComponentFixture.Here, 'fixtures', 'pragmatic-postgres.component.json')
    public static readonly Digest = 'sha256:b7f5b0d2ded8135d805d4c30e0f257ae0c6f3eb50511c4e4e4c0024903729ae0'
    public static readonly Readers = [['..', '..', 'postgres', 'Dockerfile'], ['..', '..', 'postgres', 'pragmatic-postgres-entrypoint.sh'], ['..', '..', 'postgres', 'pragmatic-postgres-reconcile.sh']].map(path => join(PragmaticPostgresComponentFixture.Here, ...path))
    /**
     * POSTGRES_INITDB_ARGS: fixed by the image. POSTGRES_PASSWORD and POSTGRES_DB: set and cleared by the entrypoint itself.
     * PRAGMATIC_POSTGRES_SUPERUSER_FILE: the entrypoint's internal alias of POSTGRES_PASSWORD_FILE.
     */
    public static readonly Undeclared: readonly string[] = ['POSTGRES_INITDB_ARGS', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'PRAGMATIC_POSTGRES_SUPERUSER_FILE']
}

describe('PragmaticPostgresComponent', () =>
{
    it('pins the descriptor: golden JSON and content digest', () =>
    {
        ComponentGolden.Check(PragmaticPostgresComponent.Descriptor(), PragmaticPostgresComponentFixture.Golden, PragmaticPostgresComponentFixture.Digest)
    })

    it('declares exactly the variables its configuration readers read', () =>
    {
        ComponentSources.AssertCovers(PragmaticPostgresComponent.Descriptor(), PragmaticPostgresComponentFixture.Readers, PragmaticPostgresComponentFixture.Undeclared)
    })

    it('is named for its release image', () =>
    {
        assert.equal(PragmaticPostgresComponent.Descriptor().Name, 'pragmatic-postgres')
    })
})
