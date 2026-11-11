import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GraphNotFoundError, GraphExistsError, GraphNameInvalidError } from '../dev-graph-service.js'
import { GraphPackageConflictError, GraphPackageSegmentError } from '../graph-package-ingest.js'
import { GraphPackageMissingError } from '../graph-package-reader.js'
import { GraphErrorCode, GraphErrorCodes } from '../graph-error-codes.js'

class CodeFixture
{
    public static readonly GraphName = 'sales'
    public static readonly PackageId = 'p'
    public static readonly PackageVersion = '1.0.0'
    public static readonly PlainMessage = 'x'
    public static readonly PlainText = 'text'
    public static readonly NotFoundMessage = 'Graph not found: sales'

    public static Cases(): Array<[Error, GraphErrorCode]>
    {
        return [
            [new GraphNotFoundError(CodeFixture.GraphName), GraphErrorCode.NotFound],
            [new GraphExistsError(CodeFixture.GraphName), GraphErrorCode.Exists],
            [new GraphNameInvalidError(CodeFixture.GraphName), GraphErrorCode.NameInvalid],
            [new GraphPackageConflictError(), GraphErrorCode.PackageConflict],
            [new GraphPackageSegmentError(), GraphErrorCode.PackageSegment],
            [new GraphPackageMissingError({ id: CodeFixture.PackageId, version: CodeFixture.PackageVersion }), GraphErrorCode.PackageMissing],
        ]
    }
}

test('each graph error maps to its code and keeps its message', () =>
{
    for (const [error, code] of CodeFixture.Cases())
    {
        assert.equal(GraphErrorCodes.CodeOf(error), code, error.name)
        const response = GraphErrorCodes.ToResponseError(error)
        assert.equal(response?.code, code, error.name)
        assert.equal(response?.message, error.message, error.name)
    }
    assert.equal(GraphErrorCodes.ToResponseError(new GraphNotFoundError(CodeFixture.GraphName))?.message, CodeFixture.NotFoundMessage)
    assert.equal(GraphErrorCode.NotFound, -32040)
    assert.equal(GraphErrorCode.PackageMissing, -32045)
})

test('a non-graph error has no code', () =>
{
    for (const value of [new Error(CodeFixture.PlainMessage), CodeFixture.PlainText])
    {
        assert.equal(GraphErrorCodes.CodeOf(value), undefined)
        assert.equal(GraphErrorCodes.ToResponseError(value), undefined)
    }
})
