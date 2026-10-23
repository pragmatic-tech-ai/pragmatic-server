import { defineConfig } from 'vite'

// Plain browser build of the admin portal. Mural is consumed as its built
// sibling dist (file: dependency); the 'development' export condition (which
// points at uncompiled src) is deliberately NOT enabled. dedupe forces one
// physical copy of mural's module-level singletons (ThemeManager, Application).
export default defineConfig({
    resolve:
    {
        conditions: ['import', 'module', 'browser', 'default'],
        dedupe: ['@pragmatic-tech-ai/mural', '@pragmatic-tech-ai/todl-runtime'],
    },
    build:
    {
        outDir: 'dist',
        target: 'es2022',
        rolldownOptions: { output: { keepNames: true } },
    },
})
