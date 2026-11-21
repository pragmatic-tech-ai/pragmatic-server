import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

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

/**
 * Which images may reach each shared package (the plan's "Used by" column). A shared home not listed here
 * (pragmatic-component, pragmatic-identity, pragmatic-identity-source-oidc) is open to every image.
 */
export class SharedHomeUsers
{
    public static readonly ByHome: ReadonlyMap<SplitHome, readonly ReleaseApp[]> = new Map<SplitHome, readonly ReleaseApp[]>([
        [SplitHome.ReleaseToolkit, [ReleaseApp.PlatformAdmin, ReleaseApp.TenantAdmin, ReleaseApp.UiUnpack]],
        [SplitHome.Kube, [ReleaseApp.PlatformAdmin, ReleaseApp.TenantAdmin, ReleaseApp.HiveAgent]],
        [SplitHome.TenantPlane, [ReleaseApp.PlatformAdmin, ReleaseApp.TenantAdmin]],
        // the tenant plane builds on the link's HTTP helpers, so the tenant console reaches them through it
        [SplitHome.PlatformLink, [ReleaseApp.PlatformAdmin, ReleaseApp.PlatformEdge, ReleaseApp.TenantAdmin]],
        [SplitHome.EnvCluster, [ReleaseApp.EnvServer, ReleaseApp.EnvGateway]],
        [SplitHome.Observability, [ReleaseApp.EnvServer, ReleaseApp.EnvGateway, ReleaseApp.HiveAgent]],
    ])

    public static Allows(home: string, app: ReleaseApp): boolean
    {
        const users = SharedHomeUsers.ByHome.get(home as SplitHome)
        return users === undefined || users.includes(app)
    }
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
        // Task 3 lifted the release toolkit, the kube client layer, the platform link, the logger and the additions to
        // pragmatic-component / pragmatic-identity / pragmatic-identity-source-oidc into pragmatic-shared; what stays:
        // the monorepo's own descriptor tooling (every image's declaration class; dev-kit A3 Ledger, Task 2) and its
        // closure-check entry (this repository's settings for the toolkit's ClosureCheck)
        ['admin/control-plane/release/release-components.ts', SplitHome.Archive],
        ['admin/control-plane/bin/pragmatic-component-descriptors.ts', SplitHome.Archive],
        ['admin/control-plane/release/tests/release-components.test.ts', SplitHome.Archive],
        ['admin/control-plane/release/tests/component-descriptor-set.test.ts', SplitHome.Archive],
        ['admin/control-plane/tests/tenant-admin-closure.test.ts', SplitHome.Archive],
        ['src/packaging/tests/workflows.test.ts', SplitHome.Archive],
        // the agent channel host's test drives it over the console's local and the edge's remote backend: the console's
        ['admin/control-plane/tests/agent-channel-host.test.ts', SplitHome.PlatformAdmin],
        // the shipped release trust key's check goes with release-keys
        ['admin/control-plane/release/tests/release-keys.test.ts', SplitHome.PlatformRelease],
        // the postgres image's shell and image tests are the postgres container's, not the toolkit's
        ['docker/postgres/tests/harness.sh', SplitHome.Postgres],
        ['docker/postgres/tests/image.test.sh', SplitHome.Postgres],
        ['docker/postgres/tests/reconcile.test.sh', SplitHome.Postgres],
        ['docker/images/tests/postgres-image.test.ts', SplitHome.Postgres],
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
        // read from disk, so no bundle sees them: the vendored descriptors are the tenant console's (ConsoleComponents),
        // the environment templates the tenant plane's (TemplateCatalog)
        ['admin/control-plane/descriptors/', SplitHome.TenantAdmin],
        ['admin/control-plane/templates/', SplitHome.TenantPlane],
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
