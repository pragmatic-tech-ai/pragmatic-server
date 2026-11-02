import { ActivitySectionService } from "./activity-section-service.js";
import { ActivityResources } from "./activity.resources.mu.js";
import { Capability, ShellModule } from "@pragmatic-tech-ai/mural/framework/shell/module.js";
import { DynamicResource, ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";

export const ActivityModule = (() => {
    const _shellModule0 = new ShellModule();
    _shellModule0.set_property_value(ShellModule.NameKey, "Activity");
    _shellModule0.AddRegistration(ServiceProvider.tokenFor(ActivitySectionService), (p) => new ActivitySectionService(p), 'singleton');
    const _capability1 = new Capability();
    _capability1.set_property_value(Capability.NameKey, "Activity");
    _capability1.set_property_value(Capability.IconKey, DynamicResource(_capability1, "ActivityIcon"));
    _capability1.set_property_value(Capability.ServiceKeyKey, ActivitySectionService);
    _shellModule0.AddChild(_capability1);
    const _rd2 = _shellModule0.Resources;
    for (const [_k, _v] of ActivityResources.Clone().Entries()) _rd2.Set(_k, _v);
    return _shellModule0;
})();
