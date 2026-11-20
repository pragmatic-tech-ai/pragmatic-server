import { ComponentDescriptorCli } from '../release/component-descriptor-cli.js'

process.exitCode = ComponentDescriptorCli.Run(process.argv.slice(2), {
    Out: line => console.log(line),
    Err: line => console.error(line),
})
