import { ConfigurationSectionService } from "./configuration-section-service.js";
import { ConfigurationResources } from "./configuration.resources.mu.js";
import { Capability, ShellModule } from "@pragmatic-tech-ai/mural/framework/shell/module.js";
import { DynamicResource, ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";

export const ConfigurationModule = (() => {
    const _shellModule0 = new ShellModule();
    _shellModule0.set_property_value(ShellModule.NameKey, "Configuration");
    _shellModule0.AddRegistration(ServiceProvider.tokenFor(ConfigurationSectionService), (p) => new ConfigurationSectionService(p), 'singleton');
    const _capability1 = new Capability();
    _capability1.set_property_value(Capability.NameKey, "Configuration");
    _capability1.set_property_value(Capability.IconKey, DynamicResource(_capability1, "ConfigurationIcon"));
    _capability1.set_property_value(Capability.ServiceKeyKey, ConfigurationSectionService);
    _shellModule0.AddChild(_capability1);
    const _rd2 = _shellModule0.Resources;
    for (const [_k, _v] of ConfigurationResources.Clone().Entries()) _rd2.Set(_k, _v);
    return _shellModule0;
})();
