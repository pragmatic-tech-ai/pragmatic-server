import { UsersAccessSectionService } from "./users-access-section-service.js";
import { UsersAccessResources } from "./users-access.resources.mu.js";
import { Capability, ShellModule } from "@pragmatic-tech-ai/mural/framework/shell/module.js";
import { DynamicResource, ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";

export const UsersAccessModule = (() => {
    const _shellModule0 = new ShellModule();
    _shellModule0.set_property_value(ShellModule.NameKey, "Users & Access");
    _shellModule0.AddRegistration(ServiceProvider.tokenFor(UsersAccessSectionService), (p) => new UsersAccessSectionService(p), 'singleton');
    const _capability1 = new Capability();
    _capability1.set_property_value(Capability.NameKey, "Users & Access");
    _capability1.set_property_value(Capability.IconKey, DynamicResource(_capability1, "UsersAccessIcon"));
    _capability1.set_property_value(Capability.ServiceKeyKey, UsersAccessSectionService);
    _shellModule0.AddChild(_capability1);
    const _rd2 = _shellModule0.Resources;
    for (const [_k, _v] of UsersAccessResources.Clone().Entries()) _rd2.Set(_k, _v);
    return _shellModule0;
})();
