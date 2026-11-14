import { createHash } from 'node:crypto'

/**
 * The sign-in page a person reaches at `GET /auth/sign-in?environment=<env>&return=<path>` (a served app sends them
 * here when they have no session). A plain email + password form; its script posts to `/auth/browser-login` (which sets
 * the HttpOnly session cookie) and then goes to the return path. The script is a fixed text, allowed by its hash in the
 * page's Content-Security-Policy; every dynamic value is an HTML-escaped data attribute. The return path is only ever a
 * same-origin absolute path; anything else is dropped and the page just says the person is signed in.
 */
export class SignInPage
{
    public static readonly Path = '/auth/sign-in'
    public static readonly ReturnParam = 'return'
    private static readonly BrowserLoginPath = '/auth/browser-login'
    private static readonly EnvironmentQuery = '?environment='
    private static readonly MaxReturnLength = 2048
    private static readonly PathStart = '/'
    private static readonly ProtocolRelative = '//'
    private static readonly Backslash = '\\'
    private static readonly ControlCharacters = /[\u0000-\u001f\u007f]/
    private static readonly Escapes: ReadonlyArray<readonly [RegExp, string]> = [
        [/&/g, '&amp;'],
        [/"/g, '&quot;'],
        [/'/g, '&#39;'],
        [/</g, '&lt;'],
        [/>/g, '&gt;'],
    ]
    private static readonly TitleText = 'Sign in'
    private static readonly WrongText = 'The email or password is not right.'
    private static readonly FailedText = 'Signing in did not work. Try again in a moment.'
    private static readonly OfflineText = 'The server did not answer. Check the connection and try again.'
    private static readonly DoneText = 'You are signed in. You can go back to the app and reload it.'
    private static readonly EmailLabel = 'Email'
    private static readonly PasswordLabel = 'Password'
    private static readonly ParamJoin = '&'
    private static readonly ParamEquals = '='
    private static readonly Script =
        '(function(){' +
        'var f=document.getElementById("sign-in"),m=document.getElementById("message"),b=f.querySelector("button");' +
        'f.addEventListener("submit",function(e){' +
        'e.preventDefault();m.textContent="";b.disabled=true;' +
        'fetch(f.dataset.login,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},' +
        'body:JSON.stringify({email:f.email.value,password:f.password.value})})' +
        '.then(function(r){' +
        'if(r.ok){if(f.dataset.return){location.replace(f.dataset.return);return}m.textContent=f.dataset.done}' +
        'else{m.textContent=r.status===401?f.dataset.wrong:f.dataset.failed}' +
        'b.disabled=false})' +
        '.catch(function(){m.textContent=f.dataset.offline;b.disabled=false})' +
        '})})();'
    private static readonly ScriptHash = 'sha256-' + createHash('sha256').update(SignInPage.Script).digest('base64')
    /** No source but this page's own script hash; the form only posts (by fetch) back to this origin. */
    public static readonly ContentSecurityPolicy =
        "default-src 'none'; script-src '" + SignInPage.ScriptHash + "'; style-src 'unsafe-inline'; connect-src 'self'; " +
        "form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    private static readonly Style =
        'body{font-family:system-ui,sans-serif;background:#f6f6f4;color:#1d1d1b;display:flex;justify-content:center;padding-top:12vh;margin:0}' +
        'main{background:#fff;border:1px solid #ddd;border-radius:8px;padding:28px 32px;width:320px}' +
        'h1{font-size:20px;margin:0 0 4px}p.env{color:#666;font-size:13px;margin:0 0 20px}' +
        'label{display:block;font-size:13px;margin:12px 0 4px}' +
        'input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #bbb;border-radius:4px;font-size:14px}' +
        'button{margin-top:20px;width:100%;padding:9px;border:0;border-radius:4px;background:#1f7a4d;color:#fff;font-size:14px;cursor:pointer}' +
        'button:disabled{opacity:.6}#message{min-height:18px;margin-top:14px;font-size:13px;color:#a32d2d}'

    private constructor()
    {
    }

    /** The return path if it is a same-origin absolute path (`/x`, not `//host` or `/\host`), else undefined. */
    public static SafeReturn(raw: string | null): string | undefined
    {
        const S = SignInPage
        if (raw === null || raw.length === 0 || raw.length > S.MaxReturnLength)
        {
            return undefined
        }
        if (!raw.startsWith(S.PathStart) || raw.startsWith(S.ProtocolRelative) || raw.includes(S.Backslash) || S.ControlCharacters.test(raw))
        {
            return undefined
        }
        return raw
    }

    /** Where a page for `environment` sends a person back to `returnPath` after signing in. */
    public static Location(environment: string, returnPath: string): string
    {
        const S = SignInPage
        return S.Path + S.EnvironmentQuery + encodeURIComponent(environment) + S.ParamJoin + S.ReturnParam + S.ParamEquals + encodeURIComponent(returnPath)
    }

    /** The page for `environment`; `returnPath` must already be SafeReturn's answer. */
    public static Render(environment: string, returnPath: string | undefined): string
    {
        const S = SignInPage
        const e = (value: string): string => S.Escape(value)
        const login = S.BrowserLoginPath + S.EnvironmentQuery + encodeURIComponent(environment)
        return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<title>' + S.TitleText + '</title><style>' + S.Style + '</style></head><body><main>' +
            '<h1>' + S.TitleText + '</h1><p class="env">' + e(environment) + '</p>' +
            '<form id="sign-in" data-login="' + e(login) + '" data-return="' + e(returnPath ?? '') + '"' +
            ' data-wrong="' + e(S.WrongText) + '" data-failed="' + e(S.FailedText) + '" data-offline="' + e(S.OfflineText) + '" data-done="' + e(S.DoneText) + '">' +
            '<label for="email">' + S.EmailLabel + '</label><input id="email" name="email" type="email" autocomplete="username" required autofocus>' +
            '<label for="password">' + S.PasswordLabel + '</label><input id="password" name="password" type="password" autocomplete="current-password" required>' +
            '<button type="submit">' + S.TitleText + '</button><div id="message" role="alert"></div></form>' +
            '</main><script>' + S.Script + '</script></body></html>'
    }

    private static Escape(value: string): string
    {
        let out = value
        for (const [pattern, entity] of SignInPage.Escapes)
        {
            out = out.replace(pattern, entity)
        }
        return out
    }
}
