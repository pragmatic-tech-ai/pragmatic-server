// tenant-icons.mu - the Tenant Admin's rail icons.
//
// A standalone resources dictionary: each `include` splices an SVG (under
// ./icons, 24x24 solid glyphs) into a keyed Geometry resource at compile
// time. Merged into the app's resources by app.mu, so each section module's
// capability resolves `Icon = @<Key>`. The rail paints each glyph with a
// theme brush; no colour is baked in.

resources TenantIcons {
    include "icons/overview.svg"      as OverviewIcon
    include "icons/environments.svg"  as EnvironmentsIcon
    include "icons/users-access.svg"  as UsersAccessIcon
    include "icons/releases.svg"      as ReleasesIcon
    include "icons/settings.svg"      as SettingsIcon
    include "icons/connection.svg"    as ConnectionIcon
}
