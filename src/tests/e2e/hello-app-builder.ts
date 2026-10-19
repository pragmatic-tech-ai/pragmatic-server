import { cpSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { parseManifest, DtoGenerator, ProjectModelProvider, GeneratorTrigger } from '@pragmatic-tech-ai/todl'
import type { IPackageSource, ProjectManifest } from '@pragmatic-tech-ai/todl'
import { DiagnosticSink } from '@pragmatic-tech-ai/todl/build-system-core'
import type { BuildOptions, IBuildStorageProvider, OpenedOutput } from '@pragmatic-tech-ai/todl/build-system-core'
import { TodlProjectBuildManager } from '@pragmatic-tech-ai/todl/todl-build-system'
import type { CypherAppDeployParamsDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { TodlRemoteBuildRegistry } from './todl-remote-build-registry.js'

/** A package source that knows no packages: the hello app depends only on the implicit prelude. */
class EmptyPackageSource implements IPackageSource
{
    public TryGet(): Promise<undefined>
    {
        return Promise.resolve(undefined)
    }
}

/**
 * A sandbox that mirrors the remote flavor's generated/data.ts into the project tree.
 * WORKAROUND for a TODL gap: BundleAppAction stages project src/ and generated/ plus only the COMPILED sandbox
 * modules and the entry, so the sandbox-emitted remote data.ts (which is meant to shadow the snapshot one) is never
 * handed to esbuild. Mirroring it to the project path gets it staged; the real emitter's text is used unchanged.
 */
class DataMirroringStorage extends NodeFsStorage
{
    private static readonly DataPath = 'generated/data.ts'

    public constructor(dir: string, private readonly project: IStorage)
    {
        super(dir)
    }

    public override async WriteText(path: string, text: string): Promise<void>
    {
        await super.WriteText(path, text)
        if (path === DataMirroringStorage.DataPath)
        {
            await this.project.WriteText(path, text)
        }
    }
}

/** On-disk sandboxes and outputs under one scratch root. */
class ScratchBuildStorage implements IBuildStorageProvider
{
    private static readonly SandboxPrefix = 'sandbox-'
    private static readonly OutputDir = 'output'
    private static readonly MainRoot = 'main'
    private static readonly KeySeparator = '--'
    private readonly outputs = new Map<string, string>()
    private counter = 0

    public constructor(private readonly root: string, private readonly project: IStorage)
    {
    }

    public async CreateSandbox(): Promise<IStorage>
    {
        const storage = new DataMirroringStorage(join(this.root, ScratchBuildStorage.SandboxPrefix + this.counter++), this.project)
        await storage.CreateDirectory('')
        return storage
    }

    public async DeleteSandbox(sandbox: IStorage): Promise<void>
    {
        await sandbox.Delete('')
    }

    public async OpenOutput(outputName: string, options: BuildOptions): Promise<OpenedOutput>
    {
        const key = (options.OutputRootOverride ?? ScratchBuildStorage.MainRoot) + ScratchBuildStorage.KeySeparator + outputName
        let dir = this.outputs.get(key)
        if (dir === undefined)
        {
            dir = join(this.root, ScratchBuildStorage.OutputDir, key)
            await new NodeFsStorage(dir).CreateDirectory('')
            this.outputs.set(key, dir)
        }
        return { Storage: new NodeFsStorage(dir), Path: dir }
    }
}

/**
 * Builds the hello-world fixture through TODL's real html-bundle-remote pipeline (generate DTO, compile mural,
 * esbuild bundle, emit the host page + servable manifest + package closure) and shapes the output as a deploy request.
 */
export class HelloAppBuilder
{
    public static readonly AppName = 'hello'
    private static readonly FlavorId = 'html-bundle-remote'
    private static readonly BuildSystemId = 'html-bundle'
    private static readonly ManifestFile = 'project.plexus'
    private static readonly ServableManifestFile = 'servable-manifest.json'
    private static readonly Utf8 = 'utf8'
    private static readonly ScratchPrefix = 'sp0-hello-'
    private static readonly FixtureSuffix = '.fixture'
    private static readonly PackagesDir = 'packages'
    private static readonly ModelFile = 'model.json'
    private static readonly Base64 = 'base64'
    private static readonly Slash = '/'
    private static readonly ProjectDir = 'project'
    private static readonly FixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hello-app')
    private static readonly ScratchOutName = 'scratch'
    private static readonly GenerateFailed = 'fixture generation reported diagnostics: '
    private static readonly BuildFailed = 'remote build failed: '

    /** Runs the build and returns the deploy request source. The caller disposes the result to remove the scratch directory. */
    public static async Build(): Promise<BuiltHelloApp>
    {
        const root = mkdtempSync(join(tmpdir(), HelloAppBuilder.ScratchPrefix))
        const projectDir = join(root, HelloAppBuilder.ProjectDir)
        cpSync(HelloAppBuilder.FixtureDir, projectDir, { recursive: true })
        HelloAppBuilder.StripFixtureSuffix(projectDir)
        const manifest = parseManifest(readFileSync(join(projectDir, HelloAppBuilder.ManifestFile), HelloAppBuilder.Utf8))
        const project = new NodeFsStorage(projectDir)
        const source = new EmptyPackageSource()
        await HelloAppBuilder.Generate(project, manifest, source)
        const manager = new TodlProjectBuildManager(await TodlRemoteBuildRegistry.Create(), new ScratchBuildStorage(join(root, HelloAppBuilder.ScratchOutName), project))
        const { Result: result } = await manager.Build({
            Project: project,
            Manifest: manifest,
            BuildSystemId: HelloAppBuilder.BuildSystemId,
            BuildFlavorId: HelloAppBuilder.FlavorId,
            Source: source,
            Options: { Remote: { AppName: HelloAppBuilder.AppName } },
        })
        if (!result.Ok || result.OutputPath === undefined)
        {
            throw new Error(HelloAppBuilder.BuildFailed + JSON.stringify(result.Diagnostics))
        }
        return new BuiltHelloApp(root, result.OutputPath)
    }

    private static async Generate(project: IStorage, manifest: ProjectManifest, source: IPackageSource): Promise<void>
    {
        const diagnostics = new DiagnosticSink()
        const model = new ProjectModelProvider(project, manifest, source)
        await new DtoGenerator().Generate({ Project: project, Manifest: manifest, Model: model, Diagnostics: diagnostics, Reason: GeneratorTrigger.OnDemand })
        if (diagnostics.Count > 0)
        {
            throw new Error(HelloAppBuilder.GenerateFailed + JSON.stringify(diagnostics.All()))
        }
    }

    /** Renames x.ts.fixture to x.ts: keeps fixture sources out of this repo's own tsc/test globs. */
    private static StripFixtureSuffix(dir: string): void
    {
        for (const name of readdirSync(dir))
        {
            const path = join(dir, name)
            if (statSync(path).isDirectory())
            {
                HelloAppBuilder.StripFixtureSuffix(path)
            }
            else if (name.endsWith(HelloAppBuilder.FixtureSuffix))
            {
                renameSync(path, path.slice(0, -HelloAppBuilder.FixtureSuffix.length))
            }
        }
    }

    public static ServableManifestPath(outputDir: string): string
    {
        return join(outputDir, HelloAppBuilder.ServableManifestFile)
    }

    public static ModelPath(outputDir: string, id: string, version: string): string
    {
        return join(outputDir, HelloAppBuilder.PackagesDir, id, version, HelloAppBuilder.ModelFile)
    }

    public static Relative(root: string, file: string): string
    {
        return relative(root, file).split(sep).join(HelloAppBuilder.Slash)
    }

    public static Encode(bytes: Buffer): string
    {
        return bytes.toString(HelloAppBuilder.Base64)
    }
}

/** The finished remote build plus its deploy-request shaping. Dispose removes the scratch directory. */
export class BuiltHelloApp
{
    private static readonly Utf8 = 'utf8'
    private static readonly IndexFile = 'index.html'

    public constructor(private readonly root: string, private readonly outputDir: string)
    {
    }

    public IndexHtml(): string
    {
        return readFileSync(join(this.outputDir, BuiltHelloApp.IndexFile), BuiltHelloApp.Utf8)
    }

    /** Assembles the deploy request as a publisher would: servable manifest + every closure package + every UI asset. */
    public DeployParams(): CypherAppDeployParamsDto
    {
        const manifest = JSON.parse(readFileSync(HelloAppBuilder.ServableManifestPath(this.outputDir), BuiltHelloApp.Utf8)) as CypherAppDeployParamsDto['manifest']
        return {
            appName: manifest.name,
            appVersion: manifest.version,
            packages: manifest.packages.map(p => ({ id: p.id, version: p.version, modelJson: readFileSync(HelloAppBuilder.ModelPath(this.outputDir, p.id, p.version), BuiltHelloApp.Utf8) })),
            uiBundle: manifest.ui.assets.map(asset => ({ path: asset, contentBase64: HelloAppBuilder.Encode(readFileSync(join(this.outputDir, asset))) })),
            manifest,
        }
    }

    public Dispose(): void
    {
        rmSync(this.root, { recursive: true, force: true })
    }
}
