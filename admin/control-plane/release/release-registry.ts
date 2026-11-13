/** Naming shared by the release publisher, its CLI and the platform-admin release catalogue: one home for the registry host and repository paths. */
export class ReleaseRegistry
{
    /** The registry every release image and descriptor is published to. */
    public static readonly DefaultHost = 'ghcr.io'
    /** The registry namespace (organisation) every release repository lives under. */
    public static readonly DefaultNamespace = 'pragmatic-tech-ai'
    /** The scheme the registry's API is reached over when a host is named without one. */
    public static readonly HttpsScheme = 'https://'
    /** The default registry API base URL, `https://ghcr.io`. */
    public static readonly DefaultBaseUrl = ReleaseRegistry.HttpsScheme + ReleaseRegistry.DefaultHost
    private static readonly PathSeparator = '/'
    private static readonly DigestSeparator = '@'

    /** `<namespace>/<name>`, the repository path the OCI client addresses. */
    public static RepositoryPath(namespace: string, name: string): string
    {
        return namespace + ReleaseRegistry.PathSeparator + name
    }

    /** `<host>/<repository>@<digest>` (host `ghcr.io` by default), the by-digest image reference the platform records. */
    public static DigestReference(host: string, repository: string, digest: string): string
    {
        return host + ReleaseRegistry.PathSeparator + repository + ReleaseRegistry.DigestSeparator + digest
    }

    /** The image host of a registry API base URL: `https://ghcr.io` gives `ghcr.io`, `http://127.0.0.1:5000` gives `127.0.0.1:5000`. */
    public static HostOf(baseUrl: string): string
    {
        return new URL(baseUrl).host
    }
}
