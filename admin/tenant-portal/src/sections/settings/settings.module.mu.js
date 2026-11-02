import { SettingsSectionService } from "./settings-section-service.js";
import { SettingsResources } from "./settings.resources.mu.js";
import { Capability, ShellModule } from "@pragmatic-tech-ai/mural/framework/shell/module.js";
import { DynamicResource, ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";

export const SettingsModule = (() => {
    const _shellModule0 = new ShellModule();
    _shellModule0.set_property_value(ShellModule.NameKey, "Settings");
    _shellModule0.AddRegistration(ServiceProvider.tokenFor(SettingsSectionService), (p) => new SettingsSectionService(p), 'singleton');
    const _capability1 = new Capability();
    _capability1.set_property_value(Capability.NameKey, "Settings");
    _capability1.set_property_value(Capability.IconKey, DynamicResource(_capability1, "SettingsIcon"));
    _capability1.set_property_value(Capability.ServiceKeyKey, SettingsSectionService);
    _shellModule0.AddChild(_capability1);
    const _rd2 = _shellModule0.Resources;
    for (const [_k, _v] of SettingsResources.Clone().Entries()) _rd2.Set(_k, _v);
    return _shellModule0;
})();
