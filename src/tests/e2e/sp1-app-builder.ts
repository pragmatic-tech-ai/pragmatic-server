import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import {
    parseManifest,
    ProjectModelProvider,
    DtoGenerator,
    ModelInstanceGenerator,
    AppViewModelGenerator,
    AppGenerator,
    ConceptUiGenerationService,
    ConceptListViewGenerator,
    ConceptFormGenerator,
    ConceptCrudViewModelGenerator,
    GeneratorTrigger,
} from '@pragmatic-tech-ai/todl'
import type { IPackageSource, ProjectManifest, IProjectContentGenerator, GeneratorContext } from '@pragmatic-tech-ai/todl'
import { DiagnosticSink } from '@pragmatic-tech-ai/todl/build-system-core'
import { TodlProjectBuildManager } from '@pragmatic-tech-ai/todl/todl-build-system'
import type { CypherAppDeployParamsDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { EmptyPackageSource, ScratchBuildStorage, HelloAppBuilder } from './hello-app-builder.js'
import { TodlRemoteBuildRegistry } from './todl-remote-build-registry.js'

/**
 * Builds a per-concept CRUD app whose UI is GENERATED (not hand-authored): it scaffolds a one-concept
 * architecture project, runs TODL's Task-7 `ConceptUiGenerationService` to emit the list + form `.mu`,
 * the CRUD view-models, and the app-root wiring, then runs the same `html-bundle-remote` pipeline the
 * SP0 hello builder uses and shapes the output as a deploy request. The capstone deploys this and drives
 * create/edit/delete against the deployed concept over the live server write leg.
 */
export class Sp1AppBuilder
{
    public static readonly AppName = 'tasks'
    public static readonly Concept = 'sp1.task'
    public static readonly TitleField = 'title'
    public static readonly PriorityField = 'priority'
    public static readonly DoneField = 'done'

    private static readonly FlavorId = 'html-bundle-remote'
    private static readonly BuildSystemId = 'html-bundle'
    private static readonly ManifestFile = 'project.plexus'
    private static readonly ModelFile = 'model.sp1.todl'
    private static readonly Utf8 = 'utf8'
    private static readonly ScratchPrefix = 'sp1-app-'
    private static readonly ProjectDir = 'project'
    private static readonly ScratchOutName = 'scratch'
    private static readonly GenerateFailed = 'scaffold generation reported diagnostics: '
    private static readonly BuildFailed = 'remote build failed: '

    private static readonly ProjectManifestText = JSON.stringify({
        type: 'architecture',
        name: 'tasks-app',
        version: 1,
        id: 'tasks-app',
        packageVersion: '0.1.0',
    })

    private static readonly ModelText = [
        'namespace sp1',
        '{',
        '    concept task',
        '    {',
        '        title : string;',
        '        priority : integer?;',
        '        done : boolean?;',
        '    }',
        '',
        '    model TasksModel : sp1',
        '    {',
        '    }',
        '}',
        '',
    ].join('\n')

    /** Runs the generation + remote build and returns the deploy request source. The caller disposes the result. */
    public static async Build(): Promise<BuiltSp1App>
    {
        const root = mkdtempSync(join(tmpdir(), Sp1AppBuilder.ScratchPrefix))
        const projectDir = join(root, Sp1AppBuilder.ProjectDir)
        const project = new NodeFsStorage(projectDir)
        await project.CreateDirectory('')
        await project.WriteText(Sp1AppBuilder.ManifestFile, Sp1AppBuilder.ProjectManifestText)
        await project.WriteText(Sp1AppBuilder.ModelFile, Sp1AppBuilder.ModelText)

        const manifest = parseManifest(readFileSync(join(projectDir, Sp1AppBuilder.ManifestFile), Sp1AppBuilder.Utf8))
        const source = new EmptyPackageSource()
        await Sp1AppBuilder.Scaffold(project, manifest, source)
        await Sp1AppBuilder.GenerateUi(project, manifest, source)

        const manager = new TodlProjectBuildManager(await TodlRemoteBuildRegistry.Create(), new ScratchBuildStorage(join(root, Sp1AppBuilder.ScratchOutName), project))
        const { Result: result } = await manager.Build({
            Project: project,
            Manifest: manifest,
            BuildSystemId: Sp1AppBuilder.BuildSystemId,
            BuildFlavorId: Sp1AppBuilder.FlavorId,
            Source: source,
            Options: { Remote: { AppName: Sp1AppBuilder.AppName } },
        })
        if (!result.Ok || result.OutputPath === undefined)
        {
            throw new Error(Sp1AppBuilder.BuildFailed + JSON.stringify(result.Diagnostics))
        }
        return new BuiltSp1App(root, result.OutputPath)
    }

    /** Runs the architecture project's base generators so the project carries a pristine app root the UI generator can wire. */
    private static async Scaffold(project: IStorage, manifest: ProjectManifest, source: IPackageSource): Promise<void>
    {
        const generators: readonly IProjectContentGenerator[] = [
            new DtoGenerator(),
            new ModelInstanceGenerator(),
            new AppViewModelGenerator(),
            new AppGenerator(),
        ]
        const diagnostics = new DiagnosticSink()
        const ctx: GeneratorContext = {
            Project: project,
            Manifest: manifest,
            Model: new ProjectModelProvider(project, manifest, source),
            Diagnostics: diagnostics,
            Reason: GeneratorTrigger.OnDemand,
        }
        for (const generator of generators)
        {
            await generator.Generate(ctx)
        }
        if (diagnostics.Count > 0)
        {
            throw new Error(Sp1AppBuilder.GenerateFailed + JSON.stringify(diagnostics.All()))
        }
    }

    /** Runs the Task-7 concept UI generation service for the fixture concept (list + form + CRUD VMs + app-root wiring). */
    private static async GenerateUi(project: IStorage, manifest: ProjectManifest, source: IPackageSource): Promise<void>
    {
        const service = new ConceptUiGenerationService([
            new ConceptListViewGenerator(),
            new ConceptFormGenerator(),
            new ConceptCrudViewModelGenerator(),
        ])
        const model = new ProjectModelProvider(project, manifest, source)
        await service.GenerateFor(project, manifest, model, Sp1AppBuilder.Concept)
    }
}

/** The finished remote build plus its deploy-request shaping. Dispose removes the scratch directory. */
export class BuiltSp1App
{
    private static readonly Utf8 = 'utf8'

    public constructor(private readonly root: string, private readonly outputDir: string)
    {
    }

    /** Assembles the deploy request as a publisher would: servable manifest + every closure package + every UI asset. */
    public DeployParams(): CypherAppDeployParamsDto
    {
        const manifest = JSON.parse(readFileSync(HelloAppBuilder.ServableManifestPath(this.outputDir), BuiltSp1App.Utf8)) as CypherAppDeployParamsDto['manifest']
        return {
            appName: manifest.name,
            appVersion: manifest.version,
            packages: manifest.packages.map(p => ({ id: p.id, version: p.version, modelJson: readFileSync(HelloAppBuilder.ModelPath(this.outputDir, p.id, p.version), BuiltSp1App.Utf8) })),
            uiBundle: manifest.ui.assets.map(asset => ({ path: asset, contentBase64: HelloAppBuilder.Encode(readFileSync(join(this.outputDir, asset))) })),
            manifest,
        }
    }

    public Dispose(): void
    {
        rmSync(this.root, { recursive: true, force: true })
    }
}
