export interface GraphPackageRef
{
    id: string
    version: string
}

export interface GraphManifest
{
    name: string
    description: string
    packages: GraphPackageRef[]
}

export type GraphRecord = {
    manifest: GraphManifest
    createdAt: string
}
