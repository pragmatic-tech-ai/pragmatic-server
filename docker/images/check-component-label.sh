#!/usr/bin/env bash
# Checks that each image carries the component descriptor its label names: the sha256 of /pragmatic/component.json inside
# the image equals the ai.pragmatic-tech.component.digest label. Usage: check-component-label.sh <image>...
# Prints one line per image; exits 1 when any image has no label, no descriptor, or a mismatch.
set -euo pipefail

label_name='ai.pragmatic-tech.component.digest'
descriptor_path='/pragmatic/component.json'
status=0
for image in "$@"; do
    label="$(docker image inspect --format "{{ index .Config.Labels \"$label_name\" }}" "$image")"
    content="$(docker run --rm --network none --entrypoint cat "$image" "$descriptor_path" | sha256sum | cut -d ' ' -f 1)"
    if [[ "$label" =~ ^sha256:[0-9a-f]{64}$ && "$label" == "sha256:$content" ]]; then
        echo "ok $image $label"
    else
        echo "MISMATCH $image label=${label:-none} file=sha256:$content" >&2
        status=1
    fi
done
exit "$status"
