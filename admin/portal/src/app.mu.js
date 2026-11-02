import { FleetModule } from "./sections/fleet/fleet.module.mu.js";
import { PortalNavigationService } from "./shell/portal-navigation-service.js";
import { PortalSessionService } from "./shell/portal-session-service.js";
import { EditorShell } from "@pragmatic-tech-ai/mural/framework/shell/editor-shell.js";
import { ContentHostService } from "@pragmatic-tech-ai/mural/framework/shell/services/content-host-service.js";
import { NavigationService } from "@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js";
import { Pragmatic, PragmaticLight } from "@pragmatic-tech-ai/mural/resources/pragmatic";
import { Application, NameScope, ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";

export const app = (() => {
    const _app0 = new Application();
    _app0.initialize({ theme: Pragmatic, scheme: PragmaticLight });
    _app0.Services.register(ServiceProvider.tokenFor(PortalSessionService), (p) => new PortalSessionService(p), 'singleton');
    _app0.Services.register(ServiceProvider.tokenFor(ContentHostService), (p) => new ContentHostService(p), 'singleton');
    _app0.Services.register(ServiceProvider.tokenFor(NavigationService), (p) => new PortalNavigationService(p), 'singleton');
    _app0.AddModule(FleetModule);
    const _rd1 = _app0.Resources;
    const _editorShell2 = new EditorShell();
    _editorShell2.SetNameScope(new NameScope());
    _rd1.Root = _editorShell2;
    return _app0;
})();
