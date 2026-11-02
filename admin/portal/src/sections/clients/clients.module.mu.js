import { ClientsSectionService } from "./clients-section-service.js";
import { ClientsResources } from "./clients.resources.mu.js";
import { Capability, ShellModule } from "@pragmatic-tech-ai/mural/framework/shell/module.js";
import { DynamicResource, ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";

export const ClientsModule = (() => {
    const _shellModule0 = new ShellModule();
    _shellModule0.set_property_value(ShellModule.NameKey, "Clients");
    _shellModule0.AddRegistration(ServiceProvider.tokenFor(ClientsSectionService), (p) => new ClientsSectionService(p), 'singleton');
    const _capability1 = new Capability();
    _capability1.set_property_value(Capability.NameKey, "Clients");
    _capability1.set_property_value(Capability.IconKey, DynamicResource(_capability1, "ClientsIcon"));
    _capability1.set_property_value(Capability.ServiceKeyKey, ClientsSectionService);
    _shellModule0.AddChild(_capability1);
    const _rd2 = _shellModule0.Resources;
    for (const [_k, _v] of ClientsResources.Clone().Entries()) _rd2.Set(_k, _v);
    return _shellModule0;
})();
