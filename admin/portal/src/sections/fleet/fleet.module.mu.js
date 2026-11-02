import { FleetSectionService } from "./fleet-section-service.js";
import { FleetResources } from "./fleet.resources.mu.js";
import { Capability, ShellModule } from "@pragmatic-tech-ai/mural/framework/shell/module.js";
import { ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";

export const FleetModule = (() => {
    const _shellModule0 = new ShellModule();
    _shellModule0.set_property_value(ShellModule.NameKey, "Fleet");
    _shellModule0.AddRegistration(ServiceProvider.tokenFor(FleetSectionService), (p) => new FleetSectionService(p), 'singleton');
    const _capability1 = new Capability();
    _capability1.set_property_value(Capability.NameKey, "Fleet");
    _capability1.set_property_value(Capability.ServiceKeyKey, FleetSectionService);
    _shellModule0.AddChild(_capability1);
    const _rd2 = _shellModule0.Resources;
    for (const [_k, _v] of FleetResources.Clone().Entries()) _rd2.Set(_k, _v);
    return _shellModule0;
})();
