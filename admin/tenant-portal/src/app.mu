// app.mu - the Tenant Admin as a services-driven EditorShell application.
//
// The shell takes no body children: its rail binds to TenantNavigationService
// (destinations flattened from the section modules' capabilities) and its
// content region to ContentHostService, where each section presents its pages.
// The header (HeaderContent) presents TenantSessionService through the
// AppResources template.
// TenantNavigationService replaces the stock NavigationService (EditorShell
// skips its default when one is registered) so the side pane stays hidden.
// Importing this module composes the shell and activates the first section
// before any session exists; TenantBoot then initializes TenantSessionService
// and rebuilds the active section (a fresh root page, built with the
// session's permissions) before it mounts the shell.

import EditorShell from "@pragmatic-tech-ai/mural/framework/shell/editor-shell.js"
import NavigationService from "@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js"
import Pragmatic from "@pragmatic-tech-ai/mural/resources/pragmatic"
import PragmaticDark from "@pragmatic-tech-ai/mural/resources/pragmatic"
import ClipboardService from "@pragmatic-tech-ai/mural/framework/shell/services/clipboard-service.js"
import TenantSessionService from "./shell/tenant-session-service.js"
import TenantNavigationService from "./shell/tenant-navigation-service.js"
import OverviewModule from "./sections/overview/overview.module.mu.js"
import EnvironmentsModule from "./sections/environments/environments.module.mu.js"
import UsersAccessModule from "./sections/users-access/users-access.module.mu.js"
import ReleasesModule from "./sections/releases/releases.module.mu.js"
import SettingsModule from "./sections/settings/settings.module.mu.js"
import ConnectionModule from "./sections/connection/connection.module.mu.js"
import AppResources from "./app.resources.mu.js"
import ShellResources from "./shell/shell.resources.mu.js"
import TenantIcons from "./shell/tenant-icons.mu.js"

Application [ Theme = Pragmatic, Scheme = PragmaticDark ] {
    .services: {
        // The signed-in session (client, identity plate, capabilities, activity).
        TenantSessionService

        // The shared content host, at the root so the section services (root
        // singletons) resolve the same instance the shell's content region binds.
        ContentHostService

        // The rail, registered under NavigationService's key.
        TenantNavigationService -> NavigationService

        // The system clipboard (the one-time token reveal's Copy).
        ClipboardService
    }

    // Rail order: what a client owns (the design's IA).
    .modules: {
        OverviewModule
        EnvironmentsModule
        UsersAccessModule
        ReleasesModule
        SettingsModule
        ConnectionModule
    }

    resources: {
        merge ShellResources
        merge AppResources

        // Rail icons, merged app-global so each capability's
        // `Icon = @<Key>` resolves.
        merge TenantIcons

        // The rail item: Mural's icon-only activity-bar item, plus a tooltip
        // naming the section (shadows the framework's ActivityBarItem key).
        Style x:key="ActivityBarItem" [TargetType = NavigationItem]
        {
            Template = @ActivityBarItemTemplate;
            ToolTipService.ToolTip = $Label;
            ToolTipService.ToolTipPlacement = "Right";
        }

        EditorShell x:root [ HeaderContent = ContentControl [ Content = $service(TenantSessionService) ] ] { }
    }
}
