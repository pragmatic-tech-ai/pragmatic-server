// app.mu - the Platform Admin as a services-driven EditorShell application.
//
// The shell takes no body children: its rail binds to PortalNavigationService
// (destinations flattened from the section modules' capabilities) and its
// content region to ContentHostService, where each section presents its pages.
// PortalNavigationService replaces the stock NavigationService (EditorShell
// skips its default when one is registered) so the side pane stays hidden.
// The header (HeaderContent) presents PortalSessionService through the
// ShellResources template. Importing this module composes the shell and
// activates the first section before any session exists; PortalBoot then
// initializes PortalSessionService and refreshes the active section before it
// mounts the shell.

import EditorShell from "@pragmatic-tech-ai/mural/framework/shell/editor-shell.js"
import NavigationService from "@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js"
import Pragmatic from "@pragmatic-tech-ai/mural/resources/pragmatic"
import PragmaticLight from "@pragmatic-tech-ai/mural/resources/pragmatic"
import PortalSessionService from "./shell/portal-session-service.js"
import PortalNavigationService from "./shell/portal-navigation-service.js"
import ClipboardService from "@pragmatic-tech-ai/mural/framework/shell/services/clipboard-service.js"
import FleetModule from "./sections/fleet/fleet.module.mu.js"
import ClientsModule from "./sections/clients/clients.module.mu.js"
import TenantsModule from "./sections/tenants/tenants.module.mu.js"
import HivesModule from "./sections/hives/hives.module.mu.js"
import ShellResources from "./shell/shell.resources.mu.js"

Application [ Theme = Pragmatic, Scheme = PragmaticLight ] {
    .services: {
        // The signed-in session (client, email, operator context).
        PortalSessionService

        // The shared content host, at the root so the section services (root
        // singletons) resolve the same instance the shell's content region binds.
        ContentHostService

        // The rail, registered under NavigationService's key.
        PortalNavigationService -> NavigationService

        // The system clipboard (the one-time reveal pages' Copy).
        ClipboardService
    }

    .modules: {
        FleetModule
        ClientsModule
        TenantsModule
        HivesModule
    }

    resources: {
        merge ShellResources

        EditorShell x:root [ HeaderContent = ContentControl [ Content = $service(PortalSessionService) ] ] { }
    }
}
