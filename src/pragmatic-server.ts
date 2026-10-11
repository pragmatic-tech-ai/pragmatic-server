import { LazyCompositionRoot, HostKinds } from '@pragmatic-tech-ai/todl-runtime'
import type { ModuleStateProperty } from '@pragmatic-tech-ai/todl-runtime'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { NodeStorageProviderRegistry, HeadlessPromptService } from '@pragmatic-tech-ai/todl-platform-node'
import { SolutionManagerService, StoragePackageSource, StoragePackageStore, PackageStoreKey } from '@pragmatic-tech-ai/todl'
import { NodeProjectSystemComposer } from '@pragmatic-tech-ai/todl/project-system'
import { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { SolutionServicesModule, LanguageServiceModule } from './composition/server-modules.js'

export interface PragmaticServerOptions
{
    packagesRoot?: string
}

/** Headless single-tenant in-process host: composes the engine over the lazy root and opens a solution. */
export class PragmaticServer
{
    private static readonly DefaultPackagesDir = 'packages'
    private static readonly ErrorSeparator = '; '

    private readonly root: LazyCompositionRoot

    public constructor(options: PragmaticServerOptions)
    {
        const builder = LazyCompositionRoot.Builder(HostKinds.Server)
            .Module(new SolutionServicesModule())
            .Module(new LanguageServiceModule())
        this.root = builder.Build()
        this.RegisterInfrastructure(options.packagesRoot ?? PragmaticServer.DefaultPackagesDir)
    }

    public async Start(): Promise<void>
    {
        const errors = await this.root.Start()
        if (errors.length > 0)
        {
            throw new Error(errors.map(e => String(e)).join(PragmaticServer.ErrorSeparator))
        }
    }

    public async Manager(): Promise<SolutionManagerService>
    {
        return this.root.Resolve(SolutionManagerService.Key)
    }

    public async LanguageService(): Promise<ILanguageService>
    {
        return this.root.Resolve(SolutionLanguageService.Key)
    }

    public async OpenSolution(location: string): Promise<void>
    {
        const manager = await this.Manager()
        await manager.OpenSolution(location)
    }

    public StateOf(moduleId: string): ModuleStateProperty | undefined
    {
        return this.root.StateOf(moduleId)
    }

    public async Dispose(): Promise<void>
    {
        this.root.Services().dispose()
    }

    private RegisterInfrastructure(packagesRoot: string): void
    {
        const services = this.root.Services()
        services.registerInstance(SolutionManagerService.StorageRegistryKey, new NodeStorageProviderRegistry())
        services.registerInstance(SolutionManagerService.PromptServiceKey, new HeadlessPromptService())
        const packagesStorage = new NodeFsStorage(packagesRoot)
        services.registerInstance(SolutionManagerService.PackageSourceKey, new StoragePackageSource(packagesStorage))
        services.registerInstance(PackageStoreKey, new StoragePackageStore(packagesStorage))
        NodeProjectSystemComposer.Compose(services)
    }
}
