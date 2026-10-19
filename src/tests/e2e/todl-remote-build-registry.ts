import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BuildSystemRegistry } from '@pragmatic-tech-ai/todl/build-system-core'
import type { IBundler, ITypeChecker, TypeCheckResult } from '@pragmatic-tech-ai/todl/build-system-core'
import { HtmlBundleBuildSystem } from '@pragmatic-tech-ai/todl/todl-build-system'
import type { TodlBuildContext } from '@pragmatic-tech-ai/todl/todl-build-system'
import type { ProjectManifest } from '@pragmatic-tech-ai/todl'

/** The constructor surface of TODL's node-only esbuild bundler, which the package does not export. */
interface IBundlerClass
{
    new (): IBundler
}

/** Skips the tsc gate: the scratch project cannot resolve pragmatic-protocol for tsc, and esbuild's resolution already gates the bundle. */
class SkippedTypeChecker implements ITypeChecker
{
    public Check(): Promise<TypeCheckResult>
    {
        return Promise.resolve({ Diagnostics: [] })
    }
}

/**
 * Registers TODL's html-bundle build system with a bundler whose package-resolution root also exposes
 * pragmatic-protocol. TODL's own EsbuildBundler resolves bare imports from TODL's node_modules, which does not contain
 * pragmatic-protocol, so a remote-flavor bundle (whose generated data.ts imports pragmatic-protocol/browser) cannot
 * resolve it. The bundler is loaded from TODL's built dist by file path because the package's
 * export map does not expose it; the resolution root is a scratch directory of junctions to the real packages.
 */
export class TodlRemoteBuildRegistry
{
    private static readonly TodlEntry = '@pragmatic-tech-ai/todl'
    private static readonly BundlerModule = 'solution-services/todl-build-system/html-bundle/node/esbuild-bundler.js'
    private static readonly BundlerExport = 'EsbuildBundler'
    private static readonly NodeModules = 'node_modules'
    private static readonly Scope = '@pragmatic-tech-ai'
    private static readonly RootPrefix = 'sp0-resolve-root-'
    private static readonly Junction = 'junction'
    private static readonly Linked: readonly string[] = ['mural', 'todl', 'todl-runtime', 'pragmatic-protocol']
    private static readonly PackageJson = 'package.json'
    private static readonly NotFound = 'cannot locate a linked package: '
    private static readonly BadModule = 'unexpected TODL dist module shape: '

    /** Builds the registry; the resolution-root directory it creates lives under the OS temp dir. */
    public static async Create(): Promise<BuildSystemRegistry<TodlBuildContext, ProjectManifest>>
    {
        const todlDist = TodlRemoteBuildRegistry.TodlDistDir()
        const Base = await TodlRemoteBuildRegistry.Load<IBundlerClass>(todlDist, TodlRemoteBuildRegistry.BundlerModule, TodlRemoteBuildRegistry.BundlerExport)
        const root = TodlRemoteBuildRegistry.BuildResolutionRoot()
        const Anchored = class extends (Base as unknown as new () => { ResolutionRoot(): string | undefined })
        {
            public ResolutionRoot(): string | undefined
            {
                return root
            }
        }
        const registry = new BuildSystemRegistry<TodlBuildContext, ProjectManifest>()
        registry.Register(new HtmlBundleBuildSystem(new (Anchored as unknown as IBundlerClass)(), new SkippedTypeChecker()) as never)
        return registry
    }

    private static TodlDistDir(): string
    {
        const require = createRequire(import.meta.url)
        return dirname(require.resolve(TodlRemoteBuildRegistry.TodlEntry))
    }

    private static async Load<T>(todlDist: string, module: string, exportName: string): Promise<T>
    {
        const loaded = await import(pathToFileURL(join(todlDist, module)).href) as Record<string, unknown>
        const value = loaded[exportName]
        if (typeof value !== 'function')
        {
            throw new Error(TodlRemoteBuildRegistry.BadModule + exportName)
        }
        return value as T
    }

    /** A scratch directory whose node_modules/@pragmatic-tech-ai holds a junction to each real package the bundle needs. */
    private static BuildResolutionRoot(): string
    {
        const root = mkdtempSync(join(tmpdir(), TodlRemoteBuildRegistry.RootPrefix))
        const scope = join(root, TodlRemoteBuildRegistry.NodeModules, TodlRemoteBuildRegistry.Scope)
        mkdirSync(scope, { recursive: true })
        const require = createRequire(import.meta.url)
        const todlDir = dirname(dirname(require.resolve(TodlRemoteBuildRegistry.TodlEntry)))
        const candidates = [join(todlDir, TodlRemoteBuildRegistry.NodeModules, TodlRemoteBuildRegistry.Scope), join(dirname(todlDir)), join(process.cwd(), TodlRemoteBuildRegistry.NodeModules, TodlRemoteBuildRegistry.Scope)]
        for (const name of TodlRemoteBuildRegistry.Linked)
        {
            const target = TodlRemoteBuildRegistry.Find(name, todlDir, candidates)
            symlinkSync(target, join(scope, name), TodlRemoteBuildRegistry.Junction)
        }
        return root
    }

    private static Find(name: string, todlDir: string, candidates: readonly string[]): string
    {
        if (name === 'todl')
        {
            return todlDir
        }
        for (const base of candidates)
        {
            for (const dir of [join(base, name), join(base, TodlRemoteBuildRegistry.ScopeSibling(name))])
            {
                if (existsSync(join(dir, TodlRemoteBuildRegistry.PackageJson)))
                {
                    return dir
                }
            }
        }
        throw new Error(TodlRemoteBuildRegistry.NotFound + name)
    }

    /** The workspace sibling directory name for a scoped package (mural lives in Mural/). */
    private static ScopeSibling(name: string): string
    {
        return name === 'mural' ? 'Mural' : name
    }
}
