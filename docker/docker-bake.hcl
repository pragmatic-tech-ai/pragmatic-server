# One image per app: the Node apps from docker/images/Dockerfile, pragmatic-postgres from docker/postgres/Dockerfile.
# Run from the workspace root (architecture-agent/), which is the build context holding pragmatic-server and its
# siblings, in two steps. The first exports the component descriptors (and the override that labels each image with
# its descriptor digest) into pragmatic-server/docker/.components; the second bakes the images with that override:
#   NPMRC_FILE=/path/to/.npmrc docker buildx bake -f pragmatic-server/docker/docker-bake.hcl pragmatic-components
#   NPMRC_FILE=/path/to/.npmrc VERSION=1.2.3 SERVER_SHA=<sha> docker buildx bake -f pragmatic-server/docker/docker-bake.hcl \
#     -f pragmatic-server/docker/.components/docker-bake.components.json
# An image target baked without the override stops at its component stage (no COMPONENT_DIGEST to match).
# NPMRC_FILE names an .npmrc able to read @pragmatic-tech-ai packages from GitHub Packages; it reaches the build only
# as the BuildKit secret `npmrc`, never as a layer.

variable "VERSION" {
  default = "dev"
}

variable "SERVER_SHA" {
  default = "local"
}

variable "REGISTRY" {
  default = "ghcr.io/pragmatic-tech-ai"
}

variable "NPMRC_FILE" {
  default = ""
}

# The multi-arch images (platform admin, edge, postgres, and the realm sign-in service, which the central login runs on
# an arm64 host) are built per arch on native runners (release.yml, platform-images job): PLATFORMS=linux/arm64 there;
# comma-separated for a local multi-arch build. The other five stay linux/amd64.
variable "PLATFORMS" {
  default = "linux/amd64"
}

function "tags" {
  params = [app]
  result = ["${REGISTRY}/${app}:${VERSION}", "${REGISTRY}/${app}:git-${SERVER_SHA}"]
}

group "default" {
  targets = [
    "pragmatic-platform-admin",
    "pragmatic-platform-edge",
    "pragmatic-env-server",
    "pragmatic-env-gateway",
    "pragmatic-hive-agent",
    "pragmatic-tenant-admin",
    "pragmatic-tenant-idp",
    "pragmatic-ui-unpack",
    "pragmatic-postgres",
  ]
}

# Everything except the four multi-arch images (release.yml bakes these on amd64 only).
group "amd64-only" {
  targets = [
    "pragmatic-env-server",
    "pragmatic-env-gateway",
    "pragmatic-hive-agent",
    "pragmatic-tenant-admin",
    "pragmatic-ui-unpack",
  ]
}

target "_app" {
  context    = "."
  dockerfile = "pragmatic-server/docker/images/Dockerfile"
  platforms  = ["linux/amd64"]
  # Without NPMRC_FILE the build stops at its first `required=true` secret mount, naming the missing secret.
  secret     = NPMRC_FILE == "" ? [] : ["id=npmrc,src=${NPMRC_FILE}"]
  # No version or revision label: either would change every image's config (so its digest) on each release, and a hotfix
  # could no longer leave an unchanged app's digest as it was. The release descriptor records the version and every commit.
  labels = {
    "org.opencontainers.image.source" = "https://github.com/pragmatic-tech-ai/pragmatic-server"
  }
}

# Step one: every release app's component descriptor, its digest and the bake override, exported as files (one platform:
# the descriptors are the same on every arch). Not an image; built before the image targets, which read its output.
target "pragmatic-components" {
  inherits  = ["_app"]
  target    = "pragmatic-components"
  platforms = [split(",", PLATFORMS)[0]]
  output    = ["type=local,dest=pragmatic-server/docker/.components"]
}

target "pragmatic-platform-admin" {
  inherits  = ["_app"]
  target    = "pragmatic-platform-admin"
  platforms = split(",", PLATFORMS)
  tags      = tags("pragmatic-platform-admin")
}

target "pragmatic-platform-edge" {
  inherits  = ["_app"]
  target    = "pragmatic-platform-edge"
  platforms = split(",", PLATFORMS)
  tags      = tags("pragmatic-platform-edge")
}

target "pragmatic-env-server" {
  inherits = ["_app"]
  target   = "pragmatic-env-server"
  tags     = tags("pragmatic-env-server")
}

target "pragmatic-env-gateway" {
  inherits = ["_app"]
  target   = "pragmatic-env-gateway"
  tags     = tags("pragmatic-env-gateway")
}

target "pragmatic-hive-agent" {
  inherits = ["_app"]
  target   = "pragmatic-hive-agent"
  tags     = tags("pragmatic-hive-agent")
}

target "pragmatic-tenant-admin" {
  inherits = ["_app"]
  target   = "pragmatic-tenant-admin"
  tags     = tags("pragmatic-tenant-admin")
}

target "pragmatic-tenant-idp" {
  inherits  = ["_app"]
  target    = "pragmatic-tenant-idp"
  platforms = split(",", PLATFORMS)
  tags      = tags("pragmatic-tenant-idp")
}

target "pragmatic-ui-unpack" {
  inherits = ["_app"]
  target   = "pragmatic-ui-unpack"
  tags     = tags("pragmatic-ui-unpack")
}

# Postgres with the per-application reconcile (docker/postgres). Its own context: no workspace siblings, no npm secret.
target "pragmatic-postgres" {
  context    = "pragmatic-server/docker/postgres"
  dockerfile = "Dockerfile"
  platforms  = split(",", PLATFORMS)
  tags       = tags("pragmatic-postgres")
  # The descriptor the first bake step exported (pragmatic-components).
  contexts = {
    components = "pragmatic-server/docker/.components"
  }
  labels = {
    "org.opencontainers.image.source" = "https://github.com/pragmatic-tech-ai/pragmatic-server"
  }
}
