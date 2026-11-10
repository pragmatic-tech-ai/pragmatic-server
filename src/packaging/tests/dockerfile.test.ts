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

    public static IgnoreText(): string
    {
        const here = dirname(fileURLToPath(import.meta.url))
        return readFileSync(join(here, '..', '..', '..', 'docker', 'Dockerfile.dockerignore'), 'utf8')
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
    const order = ['pragmatic-graph', 'todl-runtime', 'TODL', 'pragmatic-protocol', 'todl-identity', 'todl-identity-local', 'todl-identity-host', 'todl-identity-cloud', 'todl-identity-engine', 'todl-connectors-host', 'todl-platform-node', 'todl-platform-cloud', 'todl-identity-node', 'pragmatic-server']
    let cursor = -1
    for (const name of order)
    {
        const at = text.indexOf(`/${name} `)
        const alt = at === -1 ? text.indexOf(`/${name}/`) : at
        assert.ok(alt > cursor, `expected ${name} to build after the previous package`)
        cursor = alt
    }
})

test('Dockerfile builds TODL via the common npm run build (no DOM workaround)', () =>
{
    const text = Dockerfile.Text()
    assert.doesNotMatch(text, /--lib/, 'the TODL --lib workaround must be gone')
    assert.doesNotMatch(text, /gen:prelude/, 'the inlined TODL generator mirror must be gone')
    assert.match(text, /cd TODL && npm install --no-audit --no-fund && npm run build/)
})

test('the image holds one graph engine: the sibling is in the context and TODL is re-pointed at it', () =>
{
    const text = Dockerfile.Text()
    assert.match(Dockerfile.IgnoreText(), /^!pragmatic-graph$/m, 'the allowlist admits the engine sibling')
    const link = text.indexOf('link-graph-engine.sh /workspace && cd pragmatic-server && npm install')
    assert.ok(link > text.indexOf('COPY pragmatic-server/'), 'TODL is re-pointed before the server installs and builds')
    const unlink = text.indexOf('rm /workspace/TODL/node_modules/@pragmatic-tech-ai/graph')
    const prune = text.indexOf('npm prune --omit=dev')
    const relink = text.lastIndexOf('link-graph-engine.sh /workspace')
    assert.ok(unlink !== -1 && unlink < prune && prune < relink, 'the link is dropped before the prune and re-made after it')
})

class Compose
{
    public static Text(): string
    {
        const here = dirname(fileURLToPath(import.meta.url))
        return readFileSync(join(here, '..', '..', '..', 'docker', 'docker-compose.cluster.yml'), 'utf8')
    }
}

test('the cluster compose file runs a gateway + two workers + redis with cert mounts', () =>
{
    const text = Compose.Text()
    assert.match(text, /pragmatic-gatewayd\.js/)
    assert.match(text, /pragmatic-workerd\.js/)
    assert.match(text, /redis/)
    assert.match(text, /\/run\/secrets\/tls/)
})
