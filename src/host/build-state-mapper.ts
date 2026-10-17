import { BuildState } from '@pragmatic-tech-ai/pragmatic-protocol'
import { GraphBuildState } from '@pragmatic-tech-ai/todl'

/** Maps the engine's solution-graph build lifecycle onto the wire BuildState enum. */
export class BuildStateMapper
{
    private static readonly UnknownState = 'unknown graph build state: '

    public static ToWire(state: GraphBuildState): BuildState
    {
        switch (state)
        {
            case GraphBuildState.Building:
                return BuildState.Building
            case GraphBuildState.Ready:
                return BuildState.Ready
            case GraphBuildState.Failed:
                return BuildState.Failed
            default:
                return BuildStateMapper.Unreachable(state)
        }
    }

    private static Unreachable(state: never): never
    {
        throw new Error(BuildStateMapper.UnknownState + String(state))
    }
}
