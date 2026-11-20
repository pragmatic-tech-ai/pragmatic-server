import { TenantSignInHost } from "./shell/tenant-sign-in-host.js";
import { Border } from "@pragmatic-tech-ai/mural/basic";
import { ContentControl } from "@pragmatic-tech-ai/mural/framework/base/content-control.js";
import { Pragmatic, PragmaticDark } from "@pragmatic-tech-ai/mural/resources/pragmatic";
import { Application, DynamicResource, NameScope, ServiceBinding, ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";
import { AppShellResources } from "@pragmatic-tech-ai/pragmatic-app-shell";

export const app = (() => {
    const _app0 = new Application();
    _app0.initialize({ theme: Pragmatic, scheme: PragmaticDark });
    _app0.Services.register(ServiceProvider.tokenFor(TenantSignInHost), (p) => new TenantSignInHost(p), 'singleton');
    const _rd1 = _app0.Resources;
    for (const [_k, _v] of AppShellResources.Clone().Entries()) _rd1.Set(_k, _v);
    const _border2 = new Border();
    _border2.SetNameScope(new NameScope());
    _border2.set_property_value(Border.FillKey, DynamicResource(_border2, "Bg1"));
    const _contentControl3 = new ContentControl();
    _contentControl3.set_property_value(ContentControl.ContentKey, ServiceBinding(_contentControl3, ServiceProvider.tokenFor(TenantSignInHost), "Page"));
    _border2.SetChild(_contentControl3);
    _rd1.Root = _border2;
    return _app0;
})();
