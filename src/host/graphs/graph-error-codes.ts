import { ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import { GraphNotFoundError, GraphExistsError, GraphNameInvalidError } from './dev-graph-service.js'
import { GraphPackageConflictError, GraphPackageSegmentError } from './graph-package-ingest.js'
import { GraphPackageMissingError } from './graph-package-reader.js'

/** JSON-RPC server-error codes for the graph catalog, reserved -32040..-32045. */
export enum GraphErrorCode
{
    NotFound = -32040,
    Exists = -32041,
    NameInvalid = -32042,
    PackageConflict = -32043,
    PackageSegment = -32044,
    PackageMissing = -32045,
}

/** Maps the graph domain errors onto their typed wire codes. */
export class GraphErrorCodes
{
    public static CodeOf(error: unknown): GraphErrorCode | undefined
    {
        if (error instanceof GraphNotFoundError)
        {
            return GraphErrorCode.NotFound
        }
        if (error instanceof GraphExistsError)
        {
            return GraphErrorCode.Exists
        }
        if (error instanceof GraphNameInvalidError)
        {
            return GraphErrorCode.NameInvalid
        }
        if (error instanceof GraphPackageConflictError)
        {
            return GraphErrorCode.PackageConflict
        }
        if (error instanceof GraphPackageSegmentError)
        {
            return GraphErrorCode.PackageSegment
        }
        if (error instanceof GraphPackageMissingError)
        {
            return GraphErrorCode.PackageMissing
        }
        return undefined
    }

    public static ToResponseError(error: unknown): ResponseError | undefined
    {
        const code = GraphErrorCodes.CodeOf(error)
        return code === undefined ? undefined : new ResponseError(code, (error as Error).message)
    }
}
