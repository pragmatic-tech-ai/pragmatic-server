import { HivesSectionService } from "./hives-section-service.js";
import { HivesResources } from "./hives.resources.mu.js";
import { Capability, ShellModule } from "@pragmatic-tech-ai/mural/framework/shell/module.js";
import { DynamicResource, ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";

export const HivesModule = (() => {
    const _shellModule0 = new ShellModule();
    _shellModule0.set_property_value(ShellModule.NameKey, "Hives");
    _shellModule0.AddRegistration(ServiceProvider.tokenFor(HivesSectionService), (p) => new HivesSectionService(p), 'singleton');
    const _capability1 = new Capability();
    _capability1.set_property_value(Capability.NameKey, "Hives");
    _capability1.set_property_value(Capability.IconKey, DynamicResource(_capability1, "HivesIcon"));
    _capability1.set_property_value(Capability.ServiceKeyKey, HivesSectionService);
    _shellModule0.AddChild(_capability1);
    const _rd2 = _shellModule0.Resources;
    for (const [_k, _v] of HivesResources.Clone().Entries()) _rd2.Set(_k, _v);
    return _shellModule0;
})();
