import { IconDefinition, parseSvgIcon } from '@pragmatic-tech-ai/mural/basic'

// Lucide glyph names (stroke icons, 24x24) available to the Platform-Admin UI kit.
export enum KitGlyph
{
    RadioTower = 'radio-tower',
    WifiOff = 'wifi-off',
    CircleDashed = 'circle-dashed',
    Hourglass = 'hourglass',
    Ban = 'ban',
    CircleCheck = 'circle-check',
    TriangleAlert = 'triangle-alert',
    CircleAlert = 'circle-alert',
    RefreshCw = 'refresh-cw',
    CircleX = 'circle-x',
    Eye = 'eye',
    CirclePause = 'circle-pause',
    Check = 'check',
    Search = 'search',
    ChevronUp = 'chevron-up',
    ChevronDown = 'chevron-down',
    Server = 'server',
    Building = 'building-2',
    Users = 'users',
    HardDrive = 'hard-drive',
    Package = 'package',
    Shield = 'shield',
    Layers = 'layers',
    Settings = 'settings',
}

// A single SVG element descriptor: [tag, attributes].
type GlyphElement = readonly [string, Readonly<Record<string, string>>]

// Builds and caches Mural IconDefinitions for KitGlyph values.
export class IconCatalog
{
    private static readonly SvgOpen = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    private static readonly SvgClose = '</svg>'
    private static readonly TagOpen = '<'
    private static readonly TagSelfClose = '/>'
    private static readonly Space = ' '
    private static readonly AttrOpen = '="'
    private static readonly AttrClose = '"'

    // Element data copied verbatim from the Lucide icon set.
    private static readonly Elements: Readonly<Record<KitGlyph, readonly GlyphElement[]>> = {
        [KitGlyph.RadioTower]: [
            ['path', { d:'M4.9 16.1C1 12.2 1 5.8 4.9 1.9' }],
            ['path', { d:'M7.8 4.7a6.14 6.14 0 0 0-.8 7.5' }],
            ['circle', { cx:'12',cy:'9',r:'2' }],
            ['path', { d:'M16.2 4.8c2 2 2.26 5.11.8 7.47' }],
            ['path', { d:'M19.1 1.9a9.96 9.96 0 0 1 0 14.1' }],
            ['path', { d:'M9.5 18h5' }],
            ['path', { d:'m8 22 4-11 4 11' }],
        ],
        [KitGlyph.WifiOff]: [
            ['path', { d:'M12 20h.01' }],
            ['path', { d:'M8.5 16.429a5 5 0 0 1 7 0' }],
            ['path', { d:'M5 12.859a10 10 0 0 1 5.17-2.69' }],
            ['path', { d:'M19 12.859a10 10 0 0 0-2.007-1.523' }],
            ['path', { d:'M2 8.82a15 15 0 0 1 4.177-2.643' }],
            ['path', { d:'M22 8.82a15 15 0 0 0-11.288-3.764' }],
            ['path', { d:'m2 2 20 20' }],
        ],
        [KitGlyph.CircleDashed]: [
            ['path', { d:'M10.1 2.182a10 10 0 0 1 3.8 0' }],
            ['path', { d:'M13.9 21.818a10 10 0 0 1-3.8 0' }],
            ['path', { d:'M17.609 3.721a10 10 0 0 1 2.69 2.7' }],
            ['path', { d:'M2.182 13.9a10 10 0 0 1 0-3.8' }],
            ['path', { d:'M20.279 17.609a10 10 0 0 1-2.7 2.69' }],
            ['path', { d:'M21.818 10.1a10 10 0 0 1 0 3.8' }],
            ['path', { d:'M3.721 6.391a10 10 0 0 1 2.7-2.69' }],
            ['path', { d:'M6.391 20.279a10 10 0 0 1-2.69-2.7' }],
        ],
        [KitGlyph.Hourglass]: [
            ['path', { d:'M5 22h14' }],
            ['path', { d:'M5 2h14' }],
            ['path', { d:'M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22' }],
            ['path', { d:'M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2' }],
        ],
        [KitGlyph.Ban]: [
            ['circle', { cx:'12',cy:'12',r:'10' }],
            ['path', { d:'M4.929 4.929 19.07 19.071' }],
        ],
        [KitGlyph.CircleCheck]: [
            ['circle', { cx:'12',cy:'12',r:'10' }],
            ['path', { d:'m16 9-5.5 5.5L8 12' }],
        ],
        [KitGlyph.TriangleAlert]: [
            ['path', { d:'m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }],
            ['path', { d:'M12 9v4' }],
            ['path', { d:'M12 17h.01' }],
        ],
        [KitGlyph.CircleAlert]: [
            ['circle', { cx:'12',cy:'12',r:'10' }],
            ['line', { x1:'12',x2:'12',y1:'8',y2:'12' }],
            ['line', { x1:'12',x2:'12.01',y1:'16',y2:'16' }],
        ],
        [KitGlyph.RefreshCw]: [
            ['path', { d:'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }],
            ['path', { d:'M21 3v5h-5' }],
            ['path', { d:'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }],
            ['path', { d:'M8 16H3v5' }],
        ],
        [KitGlyph.CircleX]: [
            ['circle', { cx:'12',cy:'12',r:'10' }],
            ['path', { d:'m15 9-6 6' }],
            ['path', { d:'m9 9 6 6' }],
        ],
        [KitGlyph.Eye]: [
            ['path', { d:'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0' }],
            ['circle', { cx:'12',cy:'12',r:'3' }],
        ],
        [KitGlyph.CirclePause]: [
            ['circle', { cx:'12',cy:'12',r:'10' }],
            ['line', { x1:'10',x2:'10',y1:'15',y2:'9' }],
            ['line', { x1:'14',x2:'14',y1:'15',y2:'9' }],
        ],
        [KitGlyph.Check]: [
            ['path', { d:'M20 6 9 17l-5-5' }],
        ],
        [KitGlyph.Search]: [
            ['circle', { cx:'11',cy:'11',r:'8' }],
            ['path', { d:'m21 21-4.3-4.3' }],
        ],
        [KitGlyph.ChevronUp]: [
            ['path', { d:'m18 15-6-6-6 6' }],
        ],
        [KitGlyph.ChevronDown]: [
            ['path', { d:'m6 9 6 6 6-6' }],
        ],
        [KitGlyph.Server]: [
            ['rect', { width:'20',height:'8',x:'2',y:'2',rx:'2',ry:'2' }],
            ['rect', { width:'20',height:'8',x:'2',y:'14',rx:'2',ry:'2' }],
            ['line', { x1:'6',x2:'6.01',y1:'6',y2:'6' }],
            ['line', { x1:'6',x2:'6.01',y1:'18',y2:'18' }],
        ],
        [KitGlyph.Building]: [
            ['path', { d:'M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z' }],
            ['path', { d:'M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2' }],
            ['path', { d:'M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2' }],
            ['path', { d:'M10 6h4' }],
            ['path', { d:'M10 10h4' }],
            ['path', { d:'M10 14h4' }],
            ['path', { d:'M10 18h4' }],
        ],
        [KitGlyph.Users]: [
            ['path', { d:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }],
            ['path', { d:'M16 3.128a4 4 0 0 1 0 7.744' }],
            ['path', { d:'M22 21v-2a4 4 0 0 0-3-3.87' }],
            ['circle', { cx:'9',cy:'7',r:'4' }],
        ],
        [KitGlyph.HardDrive]: [
            ['path', { d:'M10 16h.01' }],
            ['path', { d:'M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }],
            ['path', { d:'M21.946 12.013H2.054' }],
            ['path', { d:'M6 16h.01' }],
        ],
        [KitGlyph.Package]: [
            ['path', { d:'M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z' }],
            ['path', { d:'M12 22V12' }],
            ['polyline', { points:'3.29 7 12 12 20.71 7' }],
            ['path', { d:'m7.5 4.27 9 5.15' }],
        ],
        [KitGlyph.Shield]: [
            ['path', { d:'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }],
        ],
        [KitGlyph.Layers]: [
            ['path', { d:'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z' }],
            ['path', { d:'M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12' }],
            ['path', { d:'M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17' }],
        ],
        [KitGlyph.Settings]: [
            ['path', { d:'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915' }],
            ['circle', { cx:'12',cy:'12',r:'3' }],
        ],
    }

    private static readonly Cache = new Map<KitGlyph, IconDefinition>()

    public static Definition(glyph: KitGlyph): IconDefinition
    {
        let def = IconCatalog.Cache.get(glyph)
        if (def === undefined)
        {
            def = parseSvgIcon(IconCatalog.SvgText(glyph))
            IconCatalog.Cache.set(glyph, def)
        }
        return def
    }

    private static SvgText(glyph: KitGlyph): string
    {
        let body = ''
        for (const [tag, attrs] of IconCatalog.Elements[glyph])
        {
            body += IconCatalog.TagOpen + tag
            for (const [name, value] of Object.entries(attrs))
            {
                body += IconCatalog.Space + name + IconCatalog.AttrOpen + value + IconCatalog.AttrClose
            }
            body += IconCatalog.TagSelfClose
        }
        return IconCatalog.SvgOpen + body + IconCatalog.SvgClose
    }
}
