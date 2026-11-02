// app.mu - the Platform Admin as a services-driven EditorShell application.
//
// The shell takes no body children: its rail binds to PortalNavigationService
// (destinations flattened from the section modules' capabilities) and its
// content region to ContentHostService, where each section presents its pages.
// PortalNavigationService replaces the stock NavigationService (EditorShell
// skips its default when one is registered) so the side pane stays hidden.
// PortalSessionService is initialized by main.ts before the shell is mounted.

import EditorShell from "@pragmatic-tech-ai/mural/framework/shell/editor-shell.js"
import NavigationService from "@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js"
import Pragmatic from "@pragmatic-tech-ai/mural/resources/pragmatic"
import PragmaticLight from "@pragmatic-tech-ai/mural/resources/pragmatic"
import PortalSessionService from "./shell/portal-session-service.js"
import PortalNavigationService from "./shell/portal-navigation-service.js"
import FleetModule from "./sections/fleet/fleet.module.mu.js"

Application [ Theme = Pragmatic, Scheme = PragmaticLight ] {
    .services: {
        // The signed-in session (client, email, operator context).
        PortalSessionService

        // The shared content host, at the root so the section services (root
        // singletons) resolve the same instance the shell's content region binds.
        ContentHostService

        // The rail, registered under NavigationService's key.
        PortalNavigationService -> NavigationService
    }

    .modules: {
        FleetModule
    }

    resources: {
        EditorShell x:root { }
    }
}
