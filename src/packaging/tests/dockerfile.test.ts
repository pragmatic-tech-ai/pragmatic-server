import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

class Dockerfile
{
    public static Text(): string
    {
        const here = dirname(fileURLToPath(import.meta.url))
        return readFileSync(join(here, '..', '..', '..', 'docker', 'Dockerfile'), 'utf8')
    }
}

test('Dockerfile is multi-stage with a slim runtime', () =>
{
    const text = Dockerfile.Text()
    assert.match(text, /AS\s+builder/)
    assert.match(text, /node:22-slim/)
})

test('Dockerfile runs as a non-root user and defines a healthcheck + entrypoint', () =>
{
    const text = Dockerfile.Text()
    assert.match(text, /USER\s+\w+/)
    assert.match(text, /HEALTHCHECK/)
    assert.match(text, /ENTRYPOINT\s+\[\s*"node"\s*,\s*"dist\/bin\/pragmatic-serverd\.js"\s*\]/)
})

test('Dockerfile builds the siblings in dependency order ending with pragmatic-server', () =>
{
    const text = Dockerfile.Text()
    const order = ['todl-runtime', 'TODL', 'pragmatic-protocol', 'todl-identity', 'todl-identity-local', 'todl-identity-host', 'todl-identity-cloud', 'todl-identity-engine', 'todl-connectors-host', 'todl-platform-node', 'todl-platform-cloud', 'todl-identity-node', 'pragmatic-server']
    let cursor = -1
    for (const name of order)
    {
        const at = text.indexOf(`/${name} `)
        const alt = at === -1 ? text.indexOf(`/${name}/`) : at
        assert.ok(alt > cursor, `expected ${name} to build after the previous package`)
        cursor = alt
    }
})
