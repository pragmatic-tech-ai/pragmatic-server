import { ConnectionSectionService } from "./connection-section-service.js";
import { ConnectionResources } from "./connection.resources.mu.js";
import { Capability, ShellModule } from "@pragmatic-tech-ai/mural/framework/shell/module.js";
import { DynamicResource, ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";

export const ConnectionModule = (() => {
    const _shellModule0 = new ShellModule();
    _shellModule0.set_property_value(ShellModule.NameKey, "Connection status");
    _shellModule0.AddRegistration(ServiceProvider.tokenFor(ConnectionSectionService), (p) => new ConnectionSectionService(p), 'singleton');
    const _capability1 = new Capability();
    _capability1.set_property_value(Capability.NameKey, "Connection status");
    _capability1.set_property_value(Capability.IconKey, DynamicResource(_capability1, "ConnectionIcon"));
    _capability1.set_property_value(Capability.ServiceKeyKey, ConnectionSectionService);
    _shellModule0.AddChild(_capability1);
    const _rd2 = _shellModule0.Resources;
    for (const [_k, _v] of ConnectionResources.Clone().Entries()) _rd2.Set(_k, _v);
    return _shellModule0;
})();
