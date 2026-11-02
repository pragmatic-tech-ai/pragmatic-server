# IdP sign-in app

The sign-in page of the tenant identity provider (`src/idp`, run as `pragmatic-idpd`), built in Mural markup like the admin portals. Its screen is `src/login.mu` and its view model is `src/idp-login-view-model.ts`.

The IdP serves the built app itself:

- `GET /<tenant>/authorize` returns `dist/index.html`. Its `<meta name="pragmatic-login">` is set to `failed` after a rejected sign-in (`ready` otherwise), and the page is sent with `no-store` and `frame-ancestors 'none'`.
- The app's assets are served under `/_login/` (the app is built with that base; realm keys cannot start with `_`).
- Sign in submits a native HTML form POST of `email` and `password` to the page's own URL, query included. That is exactly the form the IdP always accepted, so its handling of credentials, throttling, SSO cookie and code issue are unchanged. The password is never stored or logged by the app.

The IdP daemon refuses to start unless the app is built. It looks in `idp-login/dist` beside the package, or in `PRAGMATIC_IDP_LOGIN_DIR` when that is set. The container image builds it (`docker/Dockerfile`). Hosts composed in-process without it (tests, the SSO smoke) get a placeholder page that carries the same marker but cannot sign anyone in.

```
npm --prefix idp-login install
npm --prefix idp-login run build      # compiles login.mu, then bundles into dist/
npm --prefix idp-login test           # unit tests (view model, boot flag)
npm --prefix idp-login run test:e2e   # the built app against a fake IdP (needs a build and `npx playwright install chromium`)
```

The generated `src/*.mu.js` files are committed; rebuild after editing a `.mu` file and commit both.
