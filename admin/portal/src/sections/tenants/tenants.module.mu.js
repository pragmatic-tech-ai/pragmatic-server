import { TenantsSectionService } from "./tenants-section-service.js";
import { TenantsResources } from "./tenants.resources.mu.js";
import { Capability, ShellModule } from "@pragmatic-tech-ai/mural/framework/shell/module.js";
import { ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";

export const TenantsModule = (() => {
    const _shellModule0 = new ShellModule();
    _shellModule0.set_property_value(ShellModule.NameKey, "Tenants");
    _shellModule0.AddRegistration(ServiceProvider.tokenFor(TenantsSectionService), (p) => new TenantsSectionService(p), 'singleton');
    const _capability1 = new Capability();
    _capability1.set_property_value(Capability.NameKey, "Tenants");
    _capability1.set_property_value(Capability.ServiceKeyKey, TenantsSectionService);
    _shellModule0.AddChild(_capability1);
    const _rd2 = _shellModule0.Resources;
    for (const [_k, _v] of TenantsResources.Clone().Entries()) _rd2.Set(_k, _v);
    return _shellModule0;
})();
