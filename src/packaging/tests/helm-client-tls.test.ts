import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

class Chart
{
    private static readonly Root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'helm', 'pragmatic-server')

    public static Text(relative: string): string
    {
        return readFileSync(join(Chart.Root, relative), 'utf8')
    }

    public static Deployment(): string
    {
        return Chart.Text(join('templates', 'deployment.yaml'))
    }

    /** The text of every `{{- if .Values.clientTls.existingSecret }}` ... `{{- end }}` block. */
    public static ClientTlsBlocks(): string[]
    {
        const lines = Chart.Deployment().split('\n')
        const blocks: string[] = []
        let current: string[] | null = null
        for (const line of lines)
        {
            if (current === null && /\{\{-?\s*if \.Values\.clientTls\.existingSecret\s*-?\}\}/.test(line))
            {
                current = []
            }
            else if (current !== null && /\{\{-?\s*end\s*-?\}\}/.test(line))
            {
                blocks.push(current.join('\n'))
                current = null
            }
            else if (current !== null)
            {
                current.push(line)
            }
        }
        return blocks
    }
}

test('values default clientTls to off with a mountPath', () =>
{
    const values = Chart.Text('values.yaml')
    assert.match(values, /^clientTls:\s*\n\s+existingSecret: (''|"")\s*\n\s+mountPath: \/run\/secrets\/client-tls/m)
})

test('the standalone Deployment sets the three client TLS env vars, gated on clientTls.existingSecret', () =>
{
    const gated = Chart.ClientTlsBlocks().join('\n')
    assert.match(gated, /PRAGMATIC_CLIENT_TLS_CERT_FILE/)
    assert.match(gated, /\.Values\.clientTls\.mountPath \}\}\/tls\.crt/)
    assert.match(gated, /PRAGMATIC_CLIENT_TLS_KEY_FILE/)
    assert.match(gated, /\.Values\.clientTls\.mountPath \}\}\/tls\.key/)
    assert.match(gated, /PRAGMATIC_CLIENT_TLS_CA_FILE/)
    assert.match(gated, /\.Values\.clientTls\.mountPath \}\}\/ca\.crt/)
})

test('the client TLS secret is mounted read-only from the existingSecret, only when set', () =>
{
    const gated = Chart.ClientTlsBlocks().join('\n')
    assert.match(gated, /name: client-tls\s*\n\s+mountPath: \{\{ \.Values\.clientTls\.mountPath \}\}\s*\n\s+readOnly: true/)
    assert.match(gated, /secretName: \{\{ \.Values\.clientTls\.existingSecret \}\}/)
})

test('nothing client-TLS related appears outside the gated blocks (unset render is unchanged)', () =>
{
    let ungated = Chart.Deployment()
    for (const block of Chart.ClientTlsBlocks())
    {
        ungated = ungated.replace(block, '')
    }
    assert.equal(Chart.ClientTlsBlocks().length, 3)
    assert.doesNotMatch(ungated, /PRAGMATIC_CLIENT_TLS/)
    assert.doesNotMatch(ungated, /client-tls/)
})

test('the Secret and ConfigMap carry no TLS key or cert material', () =>
{
    for (const file of ['secret.yaml', 'configmap.yaml'])
    {
        const text = Chart.Text(join('templates', file))
        assert.doesNotMatch(text, /tls\.(key|crt)/)
        assert.doesNotMatch(text, /ca\.crt/)
        assert.doesNotMatch(text, /clientTls/)
        assert.doesNotMatch(text, /BEGIN .*(PRIVATE KEY|CERTIFICATE)/)
    }
    assert.doesNotMatch(Chart.Text('values.yaml'), /BEGIN .*(PRIVATE KEY|CERTIFICATE)/)
})

test('NOTES state the two CAs must be distinct and that multi-replica OIDC needs redis.url', () =>
{
    const notes = Chart.Text(join('templates', 'NOTES.txt'))
    assert.match(notes, /MUST be distinct/)
    assert.match(notes, /PRAGMATIC_CLIENT_TLS_CA_FILE/)
    assert.match(notes, /PRAGMATIC_TLS_CA_FILE/)
    assert.match(notes, /multi-replica OIDC login requires redis\.url/)
})
