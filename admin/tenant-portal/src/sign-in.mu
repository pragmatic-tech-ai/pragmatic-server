// sign-in.mu - the Tenant Admin's sign-in page, a small application of its own.
//
// The boot imports this only when the session probe fails for a reason other than "not signed in" (the reason shows
// on the page); with no session it sends the browser straight to the tenant's identity provider, and with one it
// imports the shell (app.mu). TenantSignInHost owns the shell's sign-in page view model (OIDC only: Sign in is the
// redirect to the identity provider, this page never asks for a password) and AppShellResources renders it.
//
// The page's ContentControl sits inside a Border root: a ContentControl as the application's root rendered nothing in
// the browser, so the root is plain chrome and the ContentControl its child.

import Pragmatic from "@pragmatic-tech-ai/mural/resources/pragmatic"
import PragmaticDark from "@pragmatic-tech-ai/mural/resources/pragmatic"
import AppShellResources from "@pragmatic-tech-ai/pragmatic-app-shell"
import TenantSignInHost from "./shell/tenant-sign-in-host.js"

Application [ Theme = Pragmatic, Scheme = PragmaticDark ] {
    .services: {
        TenantSignInHost
    }

    resources: {
        merge AppShellResources

        Border x:root [ Fill = @Bg1 ] {
            ContentControl [ Content = $service(TenantSignInHost).Page ]
        }
    }
}
