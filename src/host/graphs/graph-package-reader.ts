import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { ContributedPackageDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { PackageRef } from './dev-graph-store.js'
import { PackagePath } from './package-path.js'

export class GraphPackageMissingError extends Error
{
    private static readonly ErrorName = 'GraphPackageMissingError'
    private static readonly MessagePrefix = 'Graph package content missing: '
    private static readonly VersionSeparator = '@'

    public constructor(ref: PackageRef)
    {
        super(GraphPackageMissingError.MessagePrefix + ref.id + GraphPackageMissingError.VersionSeparator + ref.version)
        this.name = GraphPackageMissingError.ErrorName
    }
}

/** Reads compiled package content (`<id>/<version>/model.json`) from the packages store written by GraphPackageIngest. */
export class GraphPackageReader
{

    public constructor(private readonly packages: IStorage)
    {
    }

    public async ReadAll(refs: readonly PackageRef[]): Promise<ContributedPackageDto[]>
    {
        const result: ContributedPackageDto[] = []
        for (const ref of refs)
        {
            const path = PackagePath.ModelJsonPath(ref.id, ref.version)
            if (!(await this.packages.Exists(path)))
            {
                throw new GraphPackageMissingError(ref)
            }
            result.push({ id: ref.id, version: ref.version, modelJson: await this.packages.ReadText(path) })
        }
        return result
    }
}
