import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The slice of esbuild's JS API this test drives. */
interface IEsbuild
{
    build(options: Record<string, unknown>): Promise<{ metafile: { inputs: Record<string, unknown> } }>
}

/**
 * Finds esbuild without declaring it: the server's own node_modules first (tsx brings it), else the sibling TODL
 * checkout's, and loads it through its JS API.
 */
class EsbuildLocator
{
    private static readonly PackageName = 'esbuild'
    private static readonly PackageJson = 'package.json'
    private static readonly NodeModules = 'node_modules'
    private static readonly TodlSibling = '../TODL'
    private static readonly NotFoundMessage = 'esbuild not found in the server or ../TODL node_modules'

    public static async Load(serverRoot: string): Promise<IEsbuild>
    {
        for (const root of [serverRoot, resolve(serverRoot, EsbuildLocator.TodlSibling)])
        {
            if (existsSync(join(root, EsbuildLocator.NodeModules, EsbuildLocator.PackageName)))
            {
                const entry = createRequire(join(root, EsbuildLocator.PackageJson)).resolve(EsbuildLocator.PackageName)
                const loaded = await import(pathToFileURL(entry).href) as IEsbuild & { default?: IEsbuild }
                return loaded.default ?? loaded
            }
        }
        throw new Error(EsbuildLocator.NotFoundMessage)
    }
}

/** Bundles one entry point (packages external) and returns every source file esbuild loaded for it. */
class ClosureProbe
{
    private static readonly ServerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    private static readonly Separator = '/'
    private static readonly WindowsSeparator = /\\/g

    public static async InputsOf(entry: string): Promise<string[]>
    {
        const esbuild = await EsbuildLocator.Load(ClosureProbe.ServerRoot)
        const result = await esbuild.build({
            entryPoints: [entry],
            absWorkingDir: ClosureProbe.ServerRoot,
            bundle: true,
            platform: 'node',
            format: 'esm',
            packages: 'external',
            metafile: true,
            write: false,
            outdir: tmpdir(),
            logLevel: 'silent',
        })
        return Object.keys(result.metafile.inputs).map(p => p.replace(ClosureProbe.WindowsSeparator, ClosureProbe.Separator))
    }
}

/**
 * The in-hive tenant admin (pragmatic-tenant-admind) runs in a client's Kubernetes hive, so its import closure must not
 * carry the dev-box drivers: the Docker environment / IdP drivers and the kind CLI. The full control plane (server.ts)
 * composes those itself.
 *
 * TODL (and Mural, which TODL's root entry pulls in) stay in the closure on purpose: environments/seed/bundle.ts calls
 * NorthwindApp.Compile (environments/seed/compile.ts -> @pragmatic-tech-ai/todl compilePackage) when it writes a Demo
 * environment's bundle, and the in-cluster runtime (InClusterEnvironmentRuntime.Prepare -> IBundleBuilder.Generate) runs
 * that for a hive-bound Template.DemoContoso create, which the console serves (in-cluster-env-create-smoke's demo phase).
 * Mural arrives through TODL's root entry (dist/index.js -> application/model-browser.mu.js, graph-api/browser/todl-app-bootstrap.js).
 * The graph engine (@pragmatic-tech-ai/graph) is not reached: within TODL only its engine-bridge modules import it, and the
 * entries compile.ts uses (root, ./domain, ./graph-api) do not load them; no server file in this closure imports it.
 */
class Forbidden
{
    public static readonly Entry = 'admin/control-plane/bin/pragmatic-tenant-admind.ts'
    public static readonly Paths: readonly string[] = [
        'environments/seed/docker.ts',
        'admin/control-plane/docker-env-port.ts',
        'admin/control-plane/docker-idp-driver.ts',
        'admin/control-plane/idp-container-env.ts',
        'admin/control-plane/kind-image-loader.ts',
        'admin/control-plane/kind.ts',
    ]
}

describe('tenant-admin closure', () =>
{
    it('tenant-admin closure carries no dev-box drivers', async () =>
    {
        const inputs = await ClosureProbe.InputsOf(Forbidden.Entry)
        assert.ok(inputs.includes(Forbidden.Entry), 'the probe saw the entry point itself')
        const offending = inputs.filter(p => Forbidden.Paths.includes(p))
        assert.deepEqual(offending, [])
    })
})
