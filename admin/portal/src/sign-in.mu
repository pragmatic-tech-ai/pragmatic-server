// sign-in.mu - the operator sign-in, a small application of its own.
//
// AppShellBoot imports this only when there is no session (or when the session probe fails, with the reason on the
// page); the shell (app.mu) is imported only when there is one. PlatformSignInHost owns the shell's sign-in page view
// model, configured for password sign-in only (the operators' break-glass accounts), and AppShellResources renders
// it: email and password as real browser inputs, Enter submits. A successful sign-in reloads the page, which then
// boots the shell.
//
// The page's ContentControl sits inside a Border root: a ContentControl as the application's root rendered nothing in
// the browser, so the root is plain chrome and the ContentControl its child.

import Pragmatic from "@pragmatic-tech-ai/mural/resources/pragmatic"
import PragmaticDark from "@pragmatic-tech-ai/mural/resources/pragmatic"
import AppShellResources from "@pragmatic-tech-ai/pragmatic-app-shell"
import PlatformSignInHost from "./shell/platform-sign-in-host.js"

Application [ Theme = Pragmatic, Scheme = PragmaticDark ] {
    .services: {
        PlatformSignInHost
    }

    resources: {
        merge AppShellResources

        Border x:root [ Fill = @Bg1 ] {
            ContentControl [ Content = $service(PlatformSignInHost).Page ]
        }
    }
}
