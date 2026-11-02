import { EnvironmentsSectionService } from "./environments-section-service.js";
import { EnvironmentsResources } from "./environments.resources.mu.js";
import { Capability, ShellModule } from "@pragmatic-tech-ai/mural/framework/shell/module.js";
import { DynamicResource, ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";

export const EnvironmentsModule = (() => {
    const _shellModule0 = new ShellModule();
    _shellModule0.set_property_value(ShellModule.NameKey, "Environments");
    _shellModule0.AddRegistration(ServiceProvider.tokenFor(EnvironmentsSectionService), (p) => new EnvironmentsSectionService(p), 'singleton');
    const _capability1 = new Capability();
    _capability1.set_property_value(Capability.NameKey, "Environments");
    _capability1.set_property_value(Capability.IconKey, DynamicResource(_capability1, "EnvironmentsIcon"));
    _capability1.set_property_value(Capability.ServiceKeyKey, EnvironmentsSectionService);
    _shellModule0.AddChild(_capability1);
    const _rd2 = _shellModule0.Resources;
    for (const [_k, _v] of EnvironmentsResources.Clone().Entries()) _rd2.Set(_k, _v);
    return _shellModule0;
})();
