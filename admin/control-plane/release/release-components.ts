import type { ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { EnvGatewayComponent } from '../../../src/bin/env-gateway-component.js'
import { EnvServerComponent } from '../../../src/bin/env-server-component.js'
import { HiveAgentComponent } from '../../../src/agent/hive-agent-component.js'
import { TenantIdpComponent } from '../../../src/idp/tenant-idp-component.js'
import { PragmaticPostgresComponent } from '../../../docker/postgres/pragmatic-postgres-component.js'
import { PlatformAdminComponent } from '../platform-admin-component.js'
import { PlatformEdgeComponent } from '../platform-edge-component.js'
import { TenantAdminComponent } from '../tenant-admin-component.js'
import { UiUnpackComponent } from '../ui-unpack-component.js'
import { ReleaseApp, ReleaseApps } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

/** The component descriptor of every release app, each declared by its application's descriptor class. */
export class ReleaseComponents
{
    private static readonly Descriptors: ReadonlyMap<ReleaseApp, () => ComponentDescriptor> = new Map([
        [ReleaseApp.PlatformAdmin, () => PlatformAdminComponent.Descriptor()],
        [ReleaseApp.PlatformEdge, () => PlatformEdgeComponent.Descriptor()],
        [ReleaseApp.EnvServer, () => EnvServerComponent.Descriptor()],
        [ReleaseApp.EnvGateway, () => EnvGatewayComponent.Descriptor()],
        [ReleaseApp.HiveAgent, () => HiveAgentComponent.Descriptor()],
        [ReleaseApp.TenantAdmin, () => TenantAdminComponent.Descriptor()],
        [ReleaseApp.TenantIdp, () => TenantIdpComponent.Descriptor()],
        [ReleaseApp.UiUnpack, () => UiUnpackComponent.Descriptor()],
        [ReleaseApp.Postgres, () => PragmaticPostgresComponent.Descriptor()],
    ])
    private static readonly UnknownAppPrefix = 'No component descriptor for app: '

    public static Of(app: ReleaseApp): ComponentDescriptor
    {
        const descriptor = ReleaseComponents.Descriptors.get(app)
        if (descriptor === undefined)
        {
            throw new Error(ReleaseComponents.UnknownAppPrefix + app)
        }
        return descriptor()
    }

    /** Every release app with its descriptor, in ReleaseApps.All order. */
    public static All(): [ReleaseApp, ComponentDescriptor][]
    {
        return ReleaseApps.All.map(app => [app, ReleaseComponents.Of(app)])
    }
}
