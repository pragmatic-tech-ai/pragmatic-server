import { OverviewSectionService } from "./overview-section-service.js";
import { OverviewResources } from "./overview.resources.mu.js";
import { Capability, ShellModule } from "@pragmatic-tech-ai/mural/framework/shell/module.js";
import { DynamicResource, ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";

export const OverviewModule = (() => {
    const _shellModule0 = new ShellModule();
    _shellModule0.set_property_value(ShellModule.NameKey, "Overview");
    _shellModule0.AddRegistration(ServiceProvider.tokenFor(OverviewSectionService), (p) => new OverviewSectionService(p), 'singleton');
    const _capability1 = new Capability();
    _capability1.set_property_value(Capability.NameKey, "Overview");
    _capability1.set_property_value(Capability.IconKey, DynamicResource(_capability1, "OverviewIcon"));
    _capability1.set_property_value(Capability.ServiceKeyKey, OverviewSectionService);
    _shellModule0.AddChild(_capability1);
    const _rd2 = _shellModule0.Resources;
    for (const [_k, _v] of OverviewResources.Clone().Entries()) _rd2.Set(_k, _v);
    return _shellModule0;
})();
