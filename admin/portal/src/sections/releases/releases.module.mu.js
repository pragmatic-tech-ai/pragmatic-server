import { ReleasesSectionService } from "./releases-section-service.js";
import { ReleasesResources } from "./releases.resources.mu.js";
import { Capability, ShellModule } from "@pragmatic-tech-ai/mural/framework/shell/module.js";
import { DynamicResource, ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";

export const ReleasesModule = (() => {
    const _shellModule0 = new ShellModule();
    _shellModule0.set_property_value(ShellModule.NameKey, "Registry & Releases");
    _shellModule0.AddRegistration(ServiceProvider.tokenFor(ReleasesSectionService), (p) => new ReleasesSectionService(p), 'singleton');
    const _capability1 = new Capability();
    _capability1.set_property_value(Capability.NameKey, "Registry & Releases");
    _capability1.set_property_value(Capability.IconKey, DynamicResource(_capability1, "ReleasesIcon"));
    _capability1.set_property_value(Capability.ServiceKeyKey, ReleasesSectionService);
    _shellModule0.AddChild(_capability1);
    const _rd2 = _shellModule0.Resources;
    for (const [_k, _v] of ReleasesResources.Clone().Entries()) _rd2.Set(_k, _v);
    return _shellModule0;
})();
