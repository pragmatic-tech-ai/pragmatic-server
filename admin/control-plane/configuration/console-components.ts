import type { ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { EnvGatewayComponent } from '../../../src/bin/env-gateway-component.js'
import { EnvServerComponent } from '../../../src/bin/env-server-component.js'
import { HiveAgentComponent } from '../../../src/agent/hive-agent-component.js'
import { TenantIdpComponent } from '../../../src/idp/tenant-idp-component.js'
import { TenantAdminComponent } from '../tenant-admin-component.js'

/**
 * The component descriptors the tenant admin console validates configurations against: the components that run in a
 * hive (the environment server and gateway, the realm sign-in service, the hive agent, the console itself), each as
 * declared in this console's own code. The console ships in the same release as the images of its hive (one release
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

    /** The catalogue of this console's release. */
    public static Release(): ConsoleComponents
    {
        return new ConsoleComponents([
            EnvServerComponent.Descriptor(),
            EnvGatewayComponent.Descriptor(),
            TenantIdpComponent.Descriptor(),
            HiveAgentComponent.Descriptor(),
            TenantAdminComponent.Descriptor(),
        ])
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
