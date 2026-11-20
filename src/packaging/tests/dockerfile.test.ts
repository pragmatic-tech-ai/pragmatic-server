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
    const order = ['pragmatic-graph', 'todl-runtime', 'TODL', 'pragmatic-protocol', 'pragmatic-shared', 'todl-identity-engine', 'todl-connectors-host', 'pragmatic-server']
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

class Singletons
{
    public static readonly Script = 'link-workspace-singletons.sh /workspace'
    public static readonly LinkThenInstall = `${Singletons.Script} && cd pragmatic-server && npm install`
    public static readonly Unlink = `${Singletons.Script} --unlink`
    public static readonly Prune = 'npm prune --omit=dev'
    public static readonly NpmrcSecret = '--mount=type=secret,id=npmrc'
    public static readonly RunStart = 'RUN '
}

test('the image holds one graph engine and one todl-runtime: the siblings are re-pointed at them', () =>
{
    const text = Dockerfile.Text()
    assert.match(Dockerfile.IgnoreText(), /^!pragmatic-graph$/m, 'the allowlist admits the engine sibling')
    const link = text.indexOf(Singletons.LinkThenInstall)
    assert.ok(link > text.indexOf('COPY pragmatic-server/'), 'the siblings are re-pointed before the server installs and builds')
    const unlink = text.indexOf(Singletons.Unlink)
    const prune = text.indexOf(Singletons.Prune)
    const relink = text.lastIndexOf(Singletons.Script)
    assert.ok(unlink !== -1 && unlink < prune && prune < relink && relink !== unlink, 'the links are dropped before the prune and re-made after it')
    const pruneRun = text.slice(text.lastIndexOf(Singletons.RunStart, prune), prune)
    assert.ok(pruneRun.includes(Singletons.NpmrcSecret), 'the prune can restore the registry copies the siblings lock')
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
