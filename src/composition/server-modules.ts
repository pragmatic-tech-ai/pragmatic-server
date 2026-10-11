import { ModuleManifest, HostKinds } from '@pragmatic-tech-ai/todl-runtime'
import type { ILazyModule, ActivationContext } from '@pragmatic-tech-ai/todl-runtime'
import { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'

/** Lazy module providing the engine's SolutionManagerService on the Server host. */
export class SolutionServicesModule implements ILazyModule
{
    public static readonly ModuleId = 'solution-manager'

    public Manifest(): ModuleManifest
    {
        return ModuleManifest.For(SolutionServicesModule.ModuleId)
            .WithTargets(HostKinds.Server)
            .WithService(SolutionManagerService.Key)
    }

    public async Activate(context: ActivationContext): Promise<void>
    {
        context.ProvideFactory(SolutionManagerService.Key, p => new SolutionManagerService(p))
    }
}

/** Lazy module providing the language service; requires the solution-manager module first. */
export class LanguageServiceModule implements ILazyModule
{
    public static readonly ModuleId = 'language-service'

    public Manifest(): ModuleManifest
    {
        return ModuleManifest.For(LanguageServiceModule.ModuleId)
            .WithTargets(HostKinds.Server)
            .WithRequirement(SolutionServicesModule.ModuleId)
            .WithService(SolutionLanguageService.Key)
    }

    public async Activate(context: ActivationContext): Promise<void>
    {
        context.ProvideFactory(SolutionLanguageService.Key, p => new SolutionLanguageService(p))
    }
}
