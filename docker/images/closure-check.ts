import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClosureCheck, ReleaseApps, type IClosureCheckOptions } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

/**
 * pragmatic-server's image closure check: the release toolkit's ClosureCheck with this repository's settings, run from
 * the workspace root's pragmatic-server (CI, the image build) as `npx tsx docker/images/closure-check.ts [<workspace root>]`.
 */
export class ServerClosureCheck
{
    /** This repository's dir under the workspace root. */
    public static readonly RepoDir = 'pragmatic-server'
    /**
     * The sibling repos docker/images/Dockerfile copies and builds, besides pragmatic-shared, in build order. The
     * pragmatic-shared packages are not listed here: the check reads them from that workspace's package.json, so a
     * package added there is a sibling the check knows without a second list to keep in step.
     */
    public static readonly Siblings: readonly string[] = [
        'pragmatic-graph', 'todl-runtime', 'Mural', 'TODL', 'pragmatic-protocol', 'todl-identity-engine', 'todl-connectors-host',
    ]
    /**
     * Each compiled tree and the source dir it mirrors: dist/ is the server build of src/, dist-tenant-admin/ (the control
     * plane, tsconfig.tenant-admin.json) and dist-ui-unpack/ (the UI-unpack init container, tsconfig.ui-unpack.json) mirror the repo.
     */
    public static readonly CompiledRoots: ReadonlyArray<readonly [string, string]> = [
        ['dist/', 'src/'],
        ['dist-tenant-admin/', ''],
        ['dist-ui-unpack/', ''],
    ]
    /** The repository's own node_modules, as a closure.json `files` entry. */
    public static readonly ServerModules = 'pragmatic-server/node_modules'
    private static readonly ParentSegment = '..'

    /** Every Node release app (pragmatic-postgres has its own image). */
    public static Options(): IClosureCheckOptions
    {
        const C = ServerClosureCheck
        return { RepoDir: C.RepoDir, Siblings: C.Siblings, CompiledRoots: C.CompiledRoots, Apps: ReleaseApps.NodeApps }
    }

    public static Main(argv: readonly string[]): number
    {
        const workspace = resolve(fileURLToPath(import.meta.url), ServerClosureCheck.ParentSegment, ServerClosureCheck.ParentSegment, ServerClosureCheck.ParentSegment, ServerClosureCheck.ParentSegment)
        return ClosureCheck.Main([argv[0] ?? workspace], ServerClosureCheck.Options())
    }

    /** True when this module is the process entry point (not when imported by tests). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])
    }
}

if (ServerClosureCheck.IsEntryPoint())
{
    process.exitCode = ServerClosureCheck.Main(process.argv.slice(2))
}
