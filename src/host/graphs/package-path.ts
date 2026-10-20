/** Single home for the packages-store layout: `<id>/<version>/model.json`. */
export class PackagePath
{
    private static readonly ModelFile = 'model.json'
    private static readonly Separator = '/'

    public static ModelJsonPath(id: string, version: string): string
    {
        return [id, version, PackagePath.ModelFile].join(PackagePath.Separator)
    }
}
