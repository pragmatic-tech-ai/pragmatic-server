import { ReleaseApp } from '../../admin/control-plane/release/release-tag.js'

/** Where a file of pragmatic-server goes in the split (dev-kit A3 plan, Target layout): a repository or a shared package. */
export enum SplitHome
{
    TenantIdp = 'pragmatic-tenant-idp',
    TenantAdmin = 'pragmatic-tenant-admin',
    HiveAgent = 'pragmatic-hive-agent',
    PlatformAdmin = 'pragmatic-platform-admin',
    PlatformEdge = 'pragmatic-platform-edge',
    EnvServer = 'pragmatic-env-server',
    EnvGateway = 'pragmatic-env-gateway',
    UiUnpack = 'pragmatic-ui-unpack',
    Postgres = 'pragmatic-postgres',
    PlatformRelease = 'pragmatic-platform-release',
    E2e = 'pragmatic-e2e',
    ReleaseToolkit = 'pragmatic-shared/pragmatic-release-toolkit',
    Kube = 'pragmatic-shared/pragmatic-kube',
    TenantPlane = 'pragmatic-shared/pragmatic-tenant-plane',
    PlatformLink = 'pragmatic-shared/pragmatic-platform-link',
    EnvCluster = 'pragmatic-shared/pragmatic-env-cluster',
    Observability = 'pragmatic-shared/pragmatic-observability',
    Component = 'pragmatic-shared/pragmatic-component',
    Identity = 'pragmatic-shared/pragmatic-identity',
    IdentitySourceOidc = 'pragmatic-shared/pragmatic-identity-source-oidc',
    /** Stays in the archived pragmatic-server only (the monorepo's own build, the split tooling, its docs). */
    Archive = 'pragmatic-server (archive)',
}

/** One file's home and the rule that chose it. */
export interface Assignment
{
    Home: SplitHome
    Reason: string
}

/** A file no rule places, or reached by images no rule joins: the rules need an entry for it. */
export class UnassignedFileError extends Error
{
    private static readonly ErrorName = 'UnassignedFileError'
    private static readonly Prefix = 'no split rule places '
    private static readonly ReachedBy = ' (reached by '
    private static readonly Close = ')'
    private static readonly Separator = ', '

    public constructor(file: string, reachedBy: readonly ReleaseApp[])
    {
        super(UnassignedFileError.Prefix + file + (reachedBy.length === 0 ? '' : UnassignedFileError.ReachedBy + reachedBy.join(UnassignedFileError.Separator) + UnassignedFileError.Close))
        this.name = UnassignedFileError.ErrorName
    }
}

/**
 * The split's placement rules, in order: an explicit exception (the shared packages' files the plan names, the edge's
 * own files), then by reach (one image: its repository; env-server + env-gateway: pragmatic-env-cluster; the tenant
 * console + the platform console: pragmatic-tenant-plane), then, for a file no image reaches, by path prefix. Every
 * exception is data here, never a code branch.
 */
export class AssignmentRules
{
    private static readonly ExceptionReason = 'named by the plan'
    private static readonly OneImageReason = 'reached by one image'
    private static readonly EnvClusterReason = 'reached by env-server and env-gateway'
    private static readonly TenantPlaneReason = 'reached by the tenant console and the platform console'
    private static readonly PrefixReason = 'not reached; by path: '

    /** Exact files whose home the plan names, whoever reaches them. */
    public static readonly Exceptions: ReadonlyMap<string, SplitHome> = new Map<string, SplitHome>([
        // pragmatic-release-toolkit
        ['admin/control-plane/release/release-tag.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/release/release-descriptor.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/release/release-signature.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/release/release-publisher.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/release/release-publish-cli.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/release/release-registry.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/release/release-components.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/release/component-descriptor-cli.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/release/component-image-label.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/bin/pragmatic-release-publish.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/bin/pragmatic-component-descriptors.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/oci-registry-client.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/image-signer.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/image-verifier.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/pinned-image-verifier.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/ui-artifact.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/ui-artifact-signer.ts', SplitHome.ReleaseToolkit],
        ['admin/control-plane/key-store.ts', SplitHome.ReleaseToolkit],
        ['docker/images/closure-check.ts', SplitHome.ReleaseToolkit],
        ['docker/images/check-component-label.sh', SplitHome.ReleaseToolkit],
        // pragmatic-kube
        ['admin/control-plane/kube-api-client.ts', SplitHome.Kube],
        ['src/agent/kube-https-transport.ts', SplitHome.Kube],
        ['admin/control-plane/kubectl.ts', SplitHome.Kube],
        ['admin/control-plane/api-kubectl.ts', SplitHome.Kube],
        ['admin/control-plane/k8s-manifest-builder.ts', SplitHome.Kube],
        ['admin/control-plane/environment-workload.ts', SplitHome.Kube],
        ['admin/control-plane/tenant-admin-workload.ts', SplitHome.Kube],
        ['admin/control-plane/idp-workload-driver.ts', SplitHome.Kube],
        ['admin/control-plane/env-namespace-guard.ts', SplitHome.Kube],
        ['admin/control-plane/in-cluster-hive-orchestrator.ts', SplitHome.Kube],
        ['admin/control-plane/hive-orchestrator.ts', SplitHome.Kube],
        // pragmatic-platform-link
        ['admin/control-plane/internal-api-routes.ts', SplitHome.PlatformLink],
        ['admin/control-plane/internal-api-client.ts', SplitHome.PlatformLink],
        ['admin/control-plane/agent-channel-backend.ts', SplitHome.PlatformLink],
        ['admin/control-plane/desktop-discovery-contract.ts', SplitHome.PlatformLink],
        // the edge's hosts, which the console's single dev process (role `all`, the default) also serves, and the
        // helpers the edge borrows (plan Task 2 Step 3: into the link bucket)
        ['admin/control-plane/agent-channel-host.ts', SplitHome.PlatformLink],
        ['admin/control-plane/desktop-discovery-endpoint.ts', SplitHome.PlatformLink],
        ['admin/control-plane/plane-http.ts', SplitHome.PlatformLink],
        ['admin/control-plane/rollout-errors.ts', SplitHome.PlatformLink],
        ['admin/control-plane/audit-throttle.ts', SplitHome.PlatformLink],
        // pragmatic-observability
        ['src/observability/logger.ts', SplitHome.Observability],
        // additions to existing shared packages
        ['src/component/component-declaration.ts', SplitHome.Component],
        ['src/idp/realm-issuer.ts', SplitHome.Identity],
        ['src/host/token-scope.ts', SplitHome.Identity],
        ['src/idp/dev-ca.ts', SplitHome.IdentitySourceOidc],
        // the edge's own files
        ['admin/control-plane/edge-composition.ts', SplitHome.PlatformEdge],
        ['admin/control-plane/edge-host.ts', SplitHome.PlatformEdge],
        ['admin/control-plane/remote-agent-channel-backend.ts', SplitHome.PlatformEdge],
        ['admin/control-plane/remote-desktop-discovery-backend.ts', SplitHome.PlatformEdge],
        ['admin/control-plane/edge-client-address.ts', SplitHome.PlatformEdge],
        ['admin/control-plane/bin/pragmatic-platform-edged.ts', SplitHome.PlatformEdge],
        ['admin/control-plane/platform-edge-component.ts', SplitHome.PlatformEdge],
        // a container's own descriptor class (its consoles read vendored descriptors after Task 2)
        ['src/idp/tenant-idp-component.ts', SplitHome.TenantIdp],
        ['src/idp/tenant-idp-options.ts', SplitHome.TenantIdp],
        ['admin/control-plane/ui-unpack-component.ts', SplitHome.UiUnpack],
        ['admin/control-plane/platform-admin-component.ts', SplitHome.PlatformAdmin],
        ['admin/control-plane/tenant-admin-component.ts', SplitHome.TenantAdmin],
        ['src/bin/env-server-component.ts', SplitHome.EnvServer],
        ['src/bin/env-gateway-component.ts', SplitHome.EnvGateway],
        ['src/agent/hive-agent-component.ts', SplitHome.HiveAgent],
        ['docker/postgres/pragmatic-postgres-component.ts', SplitHome.Postgres],
        // the vendored descriptor set: the consoles read it (ComponentDescriptorSet goes to the release toolkit)
        ['admin/control-plane/release/component-descriptor-set.ts', SplitHome.ReleaseToolkit],
        // the env-server's operator bootstrap, which the platform console reaches until Task 2 untangles it
        ['src/identity/server-bootstrap.ts', SplitHome.EnvServer],
        ['release-keys/release-2026-11.pub.pem', SplitHome.PlatformRelease],
    ])

    /** For a file no image reaches: the first matching prefix. */
    public static readonly Prefixes: readonly (readonly [string, SplitHome])[] = [
        ['tools/split/', SplitHome.Archive],
        ['admin/portal/', SplitHome.PlatformAdmin],
        ['admin/tenant-portal/', SplitHome.TenantAdmin],
        ['idp-login/', SplitHome.TenantIdp],
        ['helm/', SplitHome.EnvServer],
        ['docker/postgres/', SplitHome.Postgres],
        ['docker/images/', SplitHome.Archive],
        ['docker/', SplitHome.EnvServer],
        ['admin/control-plane/live-loop/', SplitHome.E2e],
        ['admin/control-plane/dev/', SplitHome.E2e],
        ['admin/control-plane/smoke-cluster.ts', SplitHome.E2e],
        ['admin/control-plane/kind-image-loader.ts', SplitHome.E2e],
        ['admin/control-plane/northwind-ui-bundle.ts', SplitHome.E2e],
        ['admin/control-plane/bin/pragmatic-tenant-admin-import.ts', SplitHome.TenantAdmin],
        ['environments/seed/', SplitHome.TenantPlane],
        ['environments/', SplitHome.PlatformAdmin],
        ['admin/README.md', SplitHome.Archive],
        ['admin/control-plane/', SplitHome.PlatformAdmin],
        ['src/', SplitHome.EnvServer],
    ]

    /** Smoke programs span containers: they go to pragmatic-e2e wherever they sit. */
    private static readonly SmokeSuffix = '-smoke.ts'

    private static readonly OneImage: ReadonlyMap<ReleaseApp, SplitHome> = new Map<ReleaseApp, SplitHome>([
        [ReleaseApp.PlatformAdmin, SplitHome.PlatformAdmin],
        [ReleaseApp.PlatformEdge, SplitHome.PlatformEdge],
        [ReleaseApp.EnvServer, SplitHome.EnvServer],
        [ReleaseApp.EnvGateway, SplitHome.EnvGateway],
        [ReleaseApp.HiveAgent, SplitHome.HiveAgent],
        [ReleaseApp.TenantAdmin, SplitHome.TenantAdmin],
        [ReleaseApp.TenantIdp, SplitHome.TenantIdp],
        [ReleaseApp.UiUnpack, SplitHome.UiUnpack],
        [ReleaseApp.Postgres, SplitHome.Postgres],
    ])

    public Assign(file: string, reachedBy: readonly ReleaseApp[]): Assignment
    {
        const R = AssignmentRules
        const exception = R.Exceptions.get(file)
        if (exception !== undefined)
        {
            return { Home: exception, Reason: R.ExceptionReason }
        }
        if (file.endsWith(R.SmokeSuffix))
        {
            return { Home: SplitHome.E2e, Reason: R.PrefixReason + R.SmokeSuffix }
        }
        const apps = new Set(reachedBy)
        // The edge runs the console's entry until it has its own: what both reach is the console's.
        if (apps.has(ReleaseApp.PlatformAdmin))
        {
            apps.delete(ReleaseApp.PlatformEdge)
        }
        if (apps.size === 1)
        {
            const [only] = apps
            return { Home: R.OneImage.get(only) as SplitHome, Reason: R.OneImageReason }
        }
        if (apps.size === 2 && apps.has(ReleaseApp.EnvServer) && apps.has(ReleaseApp.EnvGateway))
        {
            return { Home: SplitHome.EnvCluster, Reason: R.EnvClusterReason }
        }
        if (apps.size === 2 && apps.has(ReleaseApp.PlatformAdmin) && apps.has(ReleaseApp.TenantAdmin))
        {
            return { Home: SplitHome.TenantPlane, Reason: R.TenantPlaneReason }
        }
        if (apps.size > 0)
        {
            throw new UnassignedFileError(file, [...reachedBy].sort())
        }
        const prefix = R.Prefixes.find(([p]) => file.startsWith(p))
        if (prefix === undefined)
        {
            throw new UnassignedFileError(file, reachedBy)
        }
        return { Home: prefix[1], Reason: R.PrefixReason + prefix[0] }
    }
}
