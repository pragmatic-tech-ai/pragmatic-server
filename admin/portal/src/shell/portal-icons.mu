// portal-icons.mu - the portal's rail icons.
//
// A standalone resources dictionary: each `include` splices an SVG (under
// ./icons, 24x24 solid glyphs) into a keyed Geometry resource at compile
// time. Merged into the app's resources by app.mu, so each section module's
// capability resolves `Icon = @<Key>`. The rail paints each glyph with a
// theme brush; no colour is baked in.

resources PortalIcons {
    include "icons/fleet.svg"          as FleetIcon
    include "icons/clients.svg"        as ClientsIcon
    include "icons/tenants.svg"        as TenantsIcon
    include "icons/hives.svg"          as HivesIcon
    include "icons/releases.svg"       as ReleasesIcon
    include "icons/release-policy.svg" as ReleasePolicyIcon
    include "icons/activity.svg"       as ActivityIcon
    include "icons/settings.svg"       as SettingsIcon
}
