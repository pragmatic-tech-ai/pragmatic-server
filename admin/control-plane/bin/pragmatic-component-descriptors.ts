import { ComponentDescriptorCli } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ReleaseComponents } from '../release/release-components.js'

process.exitCode = ComponentDescriptorCli.Run(process.argv.slice(2), {
    Out: line => console.log(line),
    Err: line => console.error(line),
}, ReleaseComponents)
