import { ReleasePolicySectionService } from "./release-policy-section-service.js";
import { ReleasePolicyResources } from "./release-policy.resources.mu.js";
import { Capability, ShellModule } from "@pragmatic-tech-ai/mural/framework/shell/module.js";
import { DynamicResource, ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";

export const ReleasePolicyModule = (() => {
    const _shellModule0 = new ShellModule();
    _shellModule0.set_property_value(ShellModule.NameKey, "Release Policy");
    _shellModule0.AddRegistration(ServiceProvider.tokenFor(ReleasePolicySectionService), (p) => new ReleasePolicySectionService(p), 'singleton');
    const _capability1 = new Capability();
    _capability1.set_property_value(Capability.NameKey, "Release Policy");
    _capability1.set_property_value(Capability.IconKey, DynamicResource(_capability1, "ReleasePolicyIcon"));
    _capability1.set_property_value(Capability.ServiceKeyKey, ReleasePolicySectionService);
    _shellModule0.AddChild(_capability1);
    const _rd2 = _shellModule0.Resources;
    for (const [_k, _v] of ReleasePolicyResources.Clone().Entries()) _rd2.Set(_k, _v);
    return _shellModule0;
})();
