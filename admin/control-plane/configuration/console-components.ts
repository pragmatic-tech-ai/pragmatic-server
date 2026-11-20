import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ComponentDescriptorSet } from '../release/component-descriptor-set.js'
import { ReleaseApp } from '../release/release-tag.js'
import { TenantAdminComponent } from '../tenant-admin-component.js'

/**
 * The component descriptors the tenant admin console validates configurations against: the components that run in a
 * hive (the environment server and gateway, the realm sign-in service, the hive agent, the console itself): the others'
 * from the digest-pinned set vendored with the console (ComponentDescriptorSet: no container imports another's
 * declaration class), its own from its declaration. The console ships in the same release as the images of its hive (one release
 * carries every image, each labelled with the digest of exactly this descriptor), so these are the descriptors of the
 * container versions it manages; a container of another release refuses a mismatched configuration at start (its
 * runtime reader checks the digest). Reading other releases' descriptors arrives with pull-only management (stage C
 * step 4: an intent carries the descriptor digest).
 */
export class ConsoleComponents
{
    private readonly descriptors: ReadonlyMap<string, ComponentDescriptor>

    public constructor(descriptors: readonly ComponentDescriptor[])
    {
        this.descriptors = new Map(descriptors.map(d => [d.Name, d]))
    }

    /** The hive components the console configures besides itself, read from the vendored set. */
    private static readonly Vendored: readonly ReleaseApp[] = [ReleaseApp.EnvServer, ReleaseApp.EnvGateway, ReleaseApp.TenantIdp, ReleaseApp.HiveAgent]
    private static readonly MissingPrefix = 'the vendored descriptor set lacks '
    private static readonly VendoredFolder = 'descriptors'
    private static readonly ParentSegment = '..'

    /** The set vendored with the console (`admin/control-plane/descriptors`; the image stages it at the same place in
     *  the compiled tree). */
    public static VendoredDirectory(): string
    {
        const C = ConsoleComponents
        return join(dirname(fileURLToPath(import.meta.url)), C.ParentSegment, C.VendoredFolder)
    }

    /** The catalogue of this console's release. */
    public static Release(set: ComponentDescriptorSet = ComponentDescriptorSet.FromDirectory(ConsoleComponents.VendoredDirectory())): ConsoleComponents
    {
        const C = ConsoleComponents
        const others = C.Vendored.map(app =>
        {
            const descriptor = set.Get(app)
            if (descriptor === undefined)
            {
                throw new Error(C.MissingPrefix + app)
            }
            return descriptor
        })
        return new ConsoleComponents([...others, TenantAdminComponent.Descriptor()])
    }

    /** The component names, sorted. */
    public Names(): readonly string[]
    {
        return [...this.descriptors.keys()].sort()
    }

    /** The descriptor of `component`, or undefined when the console does not configure it. */
    public Of(component: string): ComponentDescriptor | undefined
    {
        return this.descriptors.get(component)
    }
}
