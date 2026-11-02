// Types for the mural compiler's generated .mu.js modules (compiled from
// src/**/*.mu by scripts/compile-mu.mjs). login.mu exports the composed
// Application as `app`; other .mu modules are reached only from markup.
declare module '*.mu.js'
{
    import type { Application } from '@pragmatic-tech-ai/mural/runtime'

    export const app: Application
    const value: unknown
    export default value
}
