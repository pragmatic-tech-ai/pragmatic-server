# IdP sign-in app

The sign-in page of the realm sign-in service (`src/idp`, run as `pragmatic-idpd` on pragmatic-app-host), built in Mural markup like the admin portals. Its screen is `src/login.mu` and its view model is `src/idp-login-view-model.ts`.

## Contract with the realm sign-in service

`<issuer>` is `https://<host>/realms/<realm>`.

- `GET <issuer>/protocol/openid-connect/auth?<OIDC authorize query>` returns `dist/index.html` (with `<meta name="pragmatic-login" content="ready">`) when the request needs a sign-in. The app's assets are served under `/_login/` (the app is built with that base; realm keys cannot start with `_`). The page derives the issuer path from `location.pathname` by stripping `/protocol/openid-connect/auth`, and the authorize request is `location.search` without its `?` (`src/login-page-location.ts`).
- `GET <issuer>/login/config` answers what the page offers: `{ realm, displayName, local, sources: [{ id, kind, label, login }], identityPlatform, signUp }`. `identityPlatform` is `null` or the Identity Platform page config (`IdentityPlatformPageConfig.ToJson()` of `@pragmatic-tech-ai/pragmatic-identity-source-identity-platform/client`: `{ projectId, apiKey, authDomain, providers, tenantId }`).
- `POST <issuer>/login` with a JSON body (same-origin fetch; app-host refuses form-encoded bodies) signs in: `{ request, method: 'password', email, password }` for the realm's local accounts, or `{ request, method: 'identityPlatform', idToken }`. A 200 answers `{ redirect }` and sets the SSO cookie; the page then navigates there. Refusals: 401 `invalid_credentials`, 401 `email_not_verified`, 429 `too_many_attempts` (with `Retry-After`), 400 `{ error, error_description }`.
- `prompt=create` in the authorize request opens the page in sign-up mode (when the realm offers sign-up); `login_hint` prefills the email.

The password is never stored or logged by the app: it is dropped from the form as soon as a sign-in starts.

## What the page shows

- One button per `sources` entry (Google, Microsoft, generic OIDC, Pragmatic): a top-level navigation to its `login` path with the authorize request appended; the service runs the upstream round trip.
- With `local: true`, the email/password form posts `method: 'password'`.
- With Identity Platform (the central realm), the browser talks to Identity Platform through the shared browser-safe client (`IdentityPlatformRestClient`) and posts the resulting ID token:
  - Sign in: `accounts:signInWithPassword`, then the post. On `email_not_verified` the page offers *Resend verification email* (`accounts:sendOobCode` with that sign-in's ID token). When the realm also has local accounts and Identity Platform rejects the credentials, the page tries the local accounts.
  - Create an account (shown when `signUp` is true and the password provider is enabled, or opened by `prompt=create`): `accounts:signUp`, then the verification email, then back to sign in with "Check your email, then sign in."
  - Forgot password: `accounts:sendOobCode` (PASSWORD_RESET) with a neutral answer (no account enumeration).
  - Continue with Google (when `providers` includes `google.com`), below.

## Google through Identity Platform

The Google button runs the shared client's federated sign-in:

1. `accounts:createAuthUri` with `{ providerId: 'google.com', continueUri, tenantId? }`, where `continueUri` is the login domain's `https://<host>/__/auth/handler` (one path for every realm: the redirect URI the central login's Google OAuth client already has; the service serves the page there without validating anything). The page saves the returned `sessionId`, the original authorize request and the realm's issuer path in `sessionStorage` (`src/federated-round-trip.ts`) and navigates to `authUri`.
2. Google sends the browser back to `continueUri` with its answer in the fragment (`response_type=id_token`); the page relocates itself under the saved realm (`FederatedRoundTrip.Locate`).
3. The page finds the saved round trip, calls `accounts:signInWithIdp` with `{ requestUri: <the whole location.href, fragment included>, sessionId, returnSecureToken: true, returnIdpCredential: true, tenantId? }`, and posts the ID token with the ORIGINAL saved authorize request (not the returned URL's query).

The federated calls are the shared client's (`IdentityPlatformRestClient.CreateAuthUri` / `SignInWithIdp`, pragmatic-shared 0.15.0). No owner action is needed: `https://login.pragmatic-tech.ai/__/auth/handler` is already an authorized redirect URI of the central login's OAuth client.

## Building

The IdP daemon refuses to start unless the app is built. It looks in `idp-login/dist` beside the package, or in `PRAGMATIC_IDP_LOGIN_DIR` when that is set. The container image builds it (`docker/Dockerfile`). Hosts composed in-process without it (tests, the SSO smoke) get a placeholder page that carries the same marker but cannot sign anyone in.

The Identity Platform client comes from the pragmatic-shared workspace (`file:../../pragmatic-shared/packages/pragmatic-identity-source-identity-platform`); only its dependency-free `./client` entry is bundled, and its `dist` must be built.

```
npm --prefix idp-login install
npm --prefix idp-login run build      # compiles login.mu, then bundles into dist/
npm --prefix idp-login test           # unit tests (view model, config, backend, Identity Platform federation, round trip)
npm --prefix idp-login run test:e2e   # the built app against a fake sign-in service (needs a build and `npx playwright install chromium`)
```

The generated `src/*.mu.js` files are committed; rebuild after editing a `.mu` file and commit both.
