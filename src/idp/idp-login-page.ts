import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A static asset of the sign-in app, ready to write. */
export type IdpLoginAsset = { bytes: Buffer; contentType: string; cacheControl: string };

/**
 * The IdP's sign-in page: the built Mural sign-in app (idp-login/dist). The page itself is the app's index.html with
 * its `<meta name="pragmatic-login">` flag set ("failed" after a rejected sign-in); the app's assets are served under
 * /_login/. The app posts the same email/password form to the authorize URL the plain page used to, so the IdP's
 * handling of the credentials is unchanged. Nothing secret is ever rendered into the page.
 */
export class IdpLoginPage
{
    /** The path segment the app's assets are served under (the app is built with base `/_login/`). */
    public static readonly AssetSegment = '_login';
    /** The flag tag every rendering carries: a stable marker that the sign-in page was served. */
    public static readonly Marker = '<meta name="pragmatic-login"';
    private static readonly ReadyFlag = '<meta name="pragmatic-login" content="ready">';
    private static readonly FailedFlag = '<meta name="pragmatic-login" content="failed">';
    private static readonly PlaceholderHtml = '<!doctype html><html><head><meta charset="utf-8">'
        + IdpLoginPage.ReadyFlag + '<title>Sign in</title></head><body><p>The sign-in app is not built.</p></body></html>';
    private static readonly IndexFile = 'index.html';
    private static readonly Utf8 = 'utf8';
    private static readonly MissingFlagMessage = 'IdpLoginPage: index.html lacks the pragmatic-login flag: ';
    private static readonly NotBuiltMessage = 'IdpLoginPage: the sign-in app is not built (run `npm --prefix idp-login run build`): ';
    private static readonly DefaultType = 'application/octet-stream';
    // Content-hashed bundle files never change under their name; everything else (fonts) is revalidated hourly.
    private static readonly HashedName = /-[A-Za-z0-9_-]{8,}\.(?:js|css)$/;
    private static readonly ImmutableCache = 'public, max-age=31536000, immutable';
    private static readonly ShortCache = 'public, max-age=3600';
    private static readonly UrlSeparator = '/';
    private static readonly Types: ReadonlyMap<string, string> = new Map([
        ['.js', 'text/javascript; charset=utf-8'],
        ['.css', 'text/css; charset=utf-8'],
        ['.woff2', 'font/woff2'],
        ['.svg', 'image/svg+xml'],
        ['.png', 'image/png'],
    ]);
    // idp-login/dist relative to this module: src/idp (tsx) and dist/idp (compiled) sit at the same depth.
    private static readonly DefaultRootSegments = ['..', '..', 'idp-login', 'dist'];

    private constructor(private readonly index: string, private readonly assets: ReadonlyMap<string, IdpLoginAsset>)
    {
    }

    /** The sign-in app built at `root` (default: idp-login/dist beside this package). Throws when it is not built. */
    public static Load(root: string = IdpLoginPage.DefaultRoot()): IdpLoginPage
    {
        const absolute = resolve(root);
        const indexPath = join(absolute, IdpLoginPage.IndexFile);
        if (!existsSync(indexPath))
        {
            throw new Error(IdpLoginPage.NotBuiltMessage + absolute);
        }
        return IdpLoginPage.Create(readFileSync(indexPath, IdpLoginPage.Utf8), IdpLoginPage.ReadAssets(absolute));
    }

    /** A page from an index document with no assets (tests). Throws when the flag is missing. */
    public static FromHtml(index: string): IdpLoginPage
    {
        return IdpLoginPage.Create(index, new Map());
    }

    /**
     * A page with no app behind it, for hosts composed without the built app (tests, in-process smokes). It carries the
     * marker and flag but cannot sign anyone in. The IdP daemon never uses it: it Loads the built app or refuses to start.
     */
    public static Placeholder(): IdpLoginPage
    {
        return IdpLoginPage.FromHtml(IdpLoginPage.PlaceholderHtml);
    }

    public static DefaultRoot(): string
    {
        return join(dirname(fileURLToPath(import.meta.url)), ...IdpLoginPage.DefaultRootSegments);
    }

    /** The page document; `failed` tells the app a sign-in was just rejected. */
    public Render(failed: boolean): string
    {
        return failed ? this.index.replace(IdpLoginPage.ReadyFlag, IdpLoginPage.FailedFlag) : this.index;
    }

    /**
     * The asset at `path` (the part after /_login/), or undefined. Only files read from the app's directory at load are
     * served (never index.html), looked up by exact relative path, so no request path can reach outside it.
     */
    public ReadAsset(path: string): IdpLoginAsset | undefined
    {
        let decoded: string;
        try
        {
            decoded = decodeURIComponent(path);
        }
        catch
        {
            return undefined;
        }
        return this.assets.get(decoded);
    }

    private static Create(index: string, assets: ReadonlyMap<string, IdpLoginAsset>): IdpLoginPage
    {
        if (!index.includes(IdpLoginPage.ReadyFlag))
        {
            throw new Error(IdpLoginPage.MissingFlagMessage + IdpLoginPage.ReadyFlag);
        }
        return new IdpLoginPage(index, assets);
    }

    // Every file under `root` except index.html, keyed by its '/'-separated relative path. The build is immutable
    // while the daemon runs, so it is read once here and served from memory.
    private static ReadAssets(root: string): Map<string, IdpLoginAsset>
    {
        const assets = new Map<string, IdpLoginAsset>();
        for (const entry of readdirSync(root, { recursive: true, withFileTypes: true }))
        {
            if (!entry.isFile())
            {
                continue;
            }
            const full = join(entry.parentPath, entry.name);
            const key = relative(root, full).split(sep).join(IdpLoginPage.UrlSeparator);
            if (key === IdpLoginPage.IndexFile)
            {
                continue;
            }
            assets.set(key, {
                bytes: readFileSync(full),
                contentType: IdpLoginPage.Types.get(extname(full)) ?? IdpLoginPage.DefaultType,
                cacheControl: IdpLoginPage.HashedName.test(key) ? IdpLoginPage.ImmutableCache : IdpLoginPage.ShortCache,
            });
        }
        return assets;
    }
}
