import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { ComponentDescriptorCodec, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'

/**
 * A golden component descriptor: the JSON an application's descriptor class builds (pretty-printed in the fixture file, so
 * a change reads as a diff) and its pinned content digest. A changed descriptor fails until fixture and digest are updated
 * together; `PRAGMATIC_UPDATE_GOLDEN=1` rewrites the fixture (the digest constant stays a deliberate edit).
 */
export class ComponentGolden
{
    private static readonly UpdateEnvVar = 'PRAGMATIC_UPDATE_GOLDEN'
    private static readonly UpdateValue = '1'
    private static readonly Utf8 = 'utf8'
    private static readonly JsonIndent = 2
    private static readonly Newline = '\n'

    public static Check(descriptor: ComponentDescriptor, fixturePath: string, digest: string): void
    {
        const G = ComponentGolden
        if (process.env[G.UpdateEnvVar] === G.UpdateValue)
        {
            writeFileSync(fixturePath, JSON.stringify(descriptor.ToJson(), null, G.JsonIndent) + G.Newline, G.Utf8)
        }
        const text = readFileSync(fixturePath, G.Utf8)
        assert.deepEqual(descriptor.ToJson(), JSON.parse(text))
        assert.equal(descriptor.ContentDigest(), digest)
        const reparsed = ComponentDescriptorCodec.Parse(descriptor.ToCanonicalJson())
        assert.equal(reparsed.ToCanonicalJson(), descriptor.ToCanonicalJson())
        assert.equal(reparsed.ContentDigest(), digest)
    }
}
