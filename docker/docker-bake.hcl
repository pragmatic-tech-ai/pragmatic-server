# One image per app, from docker/images/Dockerfile. Run from the workspace root (architecture-agent/), which is the
# build context holding pragmatic-server and its siblings:
#   NPMRC_FILE=/path/to/.npmrc VERSION=1.2.3 SERVER_SHA=<sha> docker buildx bake -f pragmatic-server/docker/docker-bake.hcl
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
  ]
}

target "_app" {
  context    = "."
  dockerfile = "pragmatic-server/docker/images/Dockerfile"
  platforms  = ["linux/amd64"]
  # Without NPMRC_FILE the build stops at its first `required=true` secret mount, naming the missing secret.
  secret     = NPMRC_FILE == "" ? [] : ["id=npmrc,src=${NPMRC_FILE}"]
  labels = {
    "org.opencontainers.image.source"   = "https://github.com/pragmatic-tech-ai/pragmatic-server"
    "org.opencontainers.image.version"  = "${VERSION}"
    "org.opencontainers.image.revision" = "${SERVER_SHA}"
  }
}

target "pragmatic-platform-admin" {
  inherits = ["_app"]
  target   = "pragmatic-platform-admin"
  tags     = tags("pragmatic-platform-admin")
}

target "pragmatic-platform-edge" {
  inherits = ["_app"]
  target   = "pragmatic-platform-edge"
  tags     = tags("pragmatic-platform-edge")
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
  inherits = ["_app"]
  target   = "pragmatic-tenant-idp"
  tags     = tags("pragmatic-tenant-idp")
}

target "pragmatic-ui-unpack" {
  inherits = ["_app"]
  target   = "pragmatic-ui-unpack"
  tags     = tags("pragmatic-ui-unpack")
}
