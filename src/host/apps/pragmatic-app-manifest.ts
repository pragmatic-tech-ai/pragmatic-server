export interface PragmaticAppPackageRef
{
    id: string
    version: string
}

export interface PragmaticAppManifest
{
    name: string
    version: string
    packages: PragmaticAppPackageRef[]
}

/** Fail-closed parser for an on-disk `application.json`. */
export class PragmaticAppManifestParser
{
    private static readonly NameField = 'name'
    private static readonly VersionField = 'version'
    private static readonly PackageIdField = 'packages.id'
    private static readonly PackageVersionField = 'packages.version'
    private static readonly InvalidJsonError = 'application manifest is not valid JSON'
    private static readonly NotObjectError = 'application manifest must be an object'
    private static readonly BadFieldError = 'application manifest has a missing or empty field: '
    private static readonly PackagesNotArrayError = 'application manifest packages must be an array'
    private static readonly BadPackageError = 'application manifest has an invalid package entry'

    public static Parse(text: string): PragmaticAppManifest
    {
        let raw: unknown
        try
        {
            raw = JSON.parse(text)
        }
        catch
        {
            throw new Error(PragmaticAppManifestParser.InvalidJsonError)
        }
        const obj = PragmaticAppManifestParser.AsRecord(raw, PragmaticAppManifestParser.NotObjectError)
        const name = PragmaticAppManifestParser.NonEmpty(obj.name, PragmaticAppManifestParser.NameField)
        const version = PragmaticAppManifestParser.NonEmpty(obj.version, PragmaticAppManifestParser.VersionField)
        if (!Array.isArray(obj.packages))
        {
            throw new Error(PragmaticAppManifestParser.PackagesNotArrayError)
        }
        const packages = obj.packages.map((p: unknown) =>
        {
            const rec = PragmaticAppManifestParser.AsRecord(p, PragmaticAppManifestParser.BadPackageError)
            return {
                id: PragmaticAppManifestParser.NonEmpty(rec.id, PragmaticAppManifestParser.PackageIdField),
                version: PragmaticAppManifestParser.NonEmpty(rec.version, PragmaticAppManifestParser.PackageVersionField),
            }
        })
        return { name, version, packages }
    }

    private static AsRecord(value: unknown, message: string): Record<string, unknown>
    {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
        {
            throw new Error(message)
        }
        return value as Record<string, unknown>
    }

    private static NonEmpty(value: unknown, field: string): string
    {
        if (typeof value !== 'string' || value.length === 0)
        {
            throw new Error(PragmaticAppManifestParser.BadFieldError + field)
        }
        return value
    }
}
