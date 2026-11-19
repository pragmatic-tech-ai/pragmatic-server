import { readFileSync } from 'node:fs'

/**
 * The kubeconfig of the clusters a hosted admin drives, delivered as a file by the secret sync. Checked once at start, so a
 * missing or wrong file stops the admin instead of every later push; the refusal names the setting, never the content.
 * KUBECONFIG is then set for this process, and every kubectl it spawns inherits it.
 */
export class HostedKubeconfig
{
    public static readonly EnvVar = 'PRAGMATIC_ADMIN_KUBECONFIG_FILE'
    private static readonly KubeconfigEnvVar = 'KUBECONFIG'
    private static readonly Utf8 = 'utf8'
    private static readonly BadFileMessage = HostedKubeconfig.EnvVar + ' must name a readable kubeconfig file'
    /** The two top-level keys every kubeconfig carries; their presence is the whole shape check (no YAML parser here). */
    private static readonly RequiredKeys: readonly RegExp[] = [/^apiVersion\s*:/m, /^clusters\s*:/m]
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly ClustersKey = 'clusters'

    private constructor()
    {
    }

    public static Apply(env: NodeJS.ProcessEnv): void
    {
        const H = HostedKubeconfig
        const path = env[H.EnvVar]?.trim() ?? ''
        if (path === '')
        {
            throw new Error(H.BadFileMessage)
        }
        let text: string
        try
        {
            text = readFileSync(path, H.Utf8)
        }
        catch
        {
            throw new Error(H.BadFileMessage)
        }
        if (!H.IsYamlKubeconfig(text) && !H.IsJsonKubeconfig(text))
        {
            throw new Error(H.BadFileMessage)
        }
        env[H.KubeconfigEnvVar] = path
    }

    private static IsYamlKubeconfig(text: string): boolean
    {
        return HostedKubeconfig.RequiredKeys.every(key => key.test(text))
    }

    /** kubectl reads a JSON kubeconfig too: an object with both keys. */
    private static IsJsonKubeconfig(text: string): boolean
    {
        try
        {
            const parsed: unknown = JSON.parse(text)
            return typeof parsed === 'object' && parsed !== null
                && Object.hasOwn(parsed, HostedKubeconfig.ApiVersionKey) && Object.hasOwn(parsed, HostedKubeconfig.ClustersKey)
        }
        catch
        {
            return false
        }
    }
}
