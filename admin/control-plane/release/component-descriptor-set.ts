import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComponentDescriptorCodec, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'

/** A vendored descriptor file does not hash to the digest pinned for it. */
export class ComponentDescriptorSetDigestError extends Error
{
    private static readonly ErrorName = 'ComponentDescriptorSetDigestError'
    private static readonly Prefix = 'vendored component descriptor does not match its pinned digest: '

    public constructor(component: string)
    {
        super(ComponentDescriptorSetDigestError.Prefix + component)
        this.name = ComponentDescriptorSetDigestError.ErrorName
    }
}

/**
 * A digest-pinned set of other containers' component descriptors, read from a directory (`digests.json` = component →
 * content digest, and one `<component>.json` each, as the descriptor CLI emits them). A console reads the descriptors of
 * the components it configures from this set instead of importing their declaration classes, so no container's code
 * reaches another's (the split, dev-kit A3 Task 2); every file is checked against its pin at load. Until C3.1 has the
 * consoles read the descriptors a signed platform release carries.
 */
export class ComponentDescriptorSet
{
    private static readonly DigestsFile = 'digests.json'
    private static readonly JsonExtension = '.json'
    private static readonly Utf8 = 'utf8'
    private static readonly VendoredFolder = 'descriptors'
    private static readonly ParentSegment = '..'

    private readonly byName: ReadonlyMap<string, ComponentDescriptor>

    private constructor(descriptors: readonly ComponentDescriptor[])
    {
        this.byName = new Map(descriptors.map(d => [d.Name, d]))
    }

    /** The set vendored beside the control plane (`admin/control-plane/descriptors`, compiled tree alike). */
    public static VendoredDirectory(): string
    {
        const C = ComponentDescriptorSet
        return join(dirname(fileURLToPath(import.meta.url)), C.ParentSegment, C.VendoredFolder)
    }

    public static FromDirectory(dir: string): ComponentDescriptorSet
    {
        const C = ComponentDescriptorSet
        const pins = JSON.parse(readFileSync(join(dir, C.DigestsFile), C.Utf8)) as Record<string, string>
        const descriptors: ComponentDescriptor[] = []
        for (const [component, digest] of Object.entries(pins))
        {
            const descriptor = ComponentDescriptorCodec.Parse(readFileSync(join(dir, component + C.JsonExtension), C.Utf8))
            if (descriptor.Name !== component || descriptor.ContentDigest() !== digest)
            {
                throw new ComponentDescriptorSetDigestError(component)
            }
            descriptors.push(descriptor)
        }
        return new ComponentDescriptorSet(descriptors)
    }

    public Get(component: string): ComponentDescriptor | undefined
    {
        return this.byName.get(component)
    }

    public All(): readonly ComponentDescriptor[]
    {
        return [...this.byName.values()]
    }
}
