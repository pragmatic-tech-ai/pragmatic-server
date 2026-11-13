import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'

class ImageChart
{
    public static readonly Workloads: readonly string[] = ['deployment.yaml', 'gateway-deployment.yaml', 'worker-statefulset.yaml']
    /** The pod-spec block: rendered only when image.pullSecrets is a non-empty list, one `- name:` per secret. */
    public static readonly PullSecretsBlock = /\{\{- with \.Values\.image\.pullSecrets \}\}\n\s+imagePullSecrets:\n\s+\{\{- range \. \}\}\n\s+- name: \{\{ \. \}\}\n\s+\{\{- end \}\}\n\s+\{\{- end \}\}/
    private static readonly Root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'helm', 'pragmatic-server')
    private static readonly CarriageReturn = /\r/g
    private static readonly Utf8 = 'utf8'

    public static Text(...relative: string[]): string
    {
        return readFileSync(join(ImageChart.Root, ...relative), ImageChart.Utf8).replace(ImageChart.CarriageReturn, '')
    }
}

test('image.pullSecrets defaults to an empty list, and the tag comment names the appVersion fallback', () =>
{
    const text = ImageChart.Text('values.yaml')
    const values = parse(text) as { image: { pullSecrets: unknown; tag: string } }
    assert.deepEqual(values.image.pullSecrets, [])
    assert.equal(values.image.tag, '')
    assert.match(text, /Chart\.appVersion/)
    assert.match(text, /bump appVersion/)
})

test('every workload wires image.pullSecrets into imagePullSecrets, rendering nothing when the list is empty', () =>
{
    for (const workload of ImageChart.Workloads)
    {
        const text = ImageChart.Text('templates', workload)
        assert.match(text, ImageChart.PullSecretsBlock, workload)
        const spec = text.indexOf('imagePullSecrets:')
        assert.ok(spec !== -1 && spec < text.indexOf('containers:'), `${workload}: the pull secrets sit in the pod spec, before the containers`)
    }
})
