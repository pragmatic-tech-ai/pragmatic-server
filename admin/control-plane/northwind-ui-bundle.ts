import type { UiDeployBundle } from './ui-deploy-actuator.js'

/** The minimal northwind demo UI the e2e deploys through the Spec-3 actuator. */
export class NorthwindUiBundle
{
    /** Recognizable text the shell body carries so the e2e can assert the UI is served. */
    public static readonly Marker = 'northwind-ui-ready'
    private static readonly AppName = 'northwind'
    private static readonly AppVersion = '1.0.0'
    private static readonly EntryPath = 'index.html'
    private static readonly AssetPath = 'assets/app.js'
    private static readonly IndexHtml =
        '<!DOCTYPE html>\n' +
        '<html><head><meta charset="utf-8"><title>Northwind</title></head>\n' +
        '<body><h1>northwind-ui-ready</h1><script src="assets/app.js"></script></body></html>\n'
    private static readonly AppJs = "console.log('northwind-ui-ready');\n"

    /** Builds the demo bundle: the artifact config plus the entry shell and its one asset. */
    public static Load(): UiDeployBundle
    {
        const encoder = new TextEncoder()
        return {
            config:
            {
                appName: NorthwindUiBundle.AppName,
                appVersion: NorthwindUiBundle.AppVersion,
                entry: NorthwindUiBundle.EntryPath,
                assets: [NorthwindUiBundle.AssetPath],
            },
            files:
            [
                { path: NorthwindUiBundle.EntryPath, bytes: encoder.encode(NorthwindUiBundle.IndexHtml) },
                { path: NorthwindUiBundle.AssetPath, bytes: encoder.encode(NorthwindUiBundle.AppJs) },
            ],
        }
    }
}
