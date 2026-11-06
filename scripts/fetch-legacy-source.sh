#!/usr/bin/env bash
# Compatibility entrypoint: validates the bundled baseline; never fetches.
set -euo pipefail
node --input-type=module -e "import {archiveLegacySource} from './tests/helpers/legacy-source.mjs'; archiveLegacySource(process.cwd()); console.log('legacy source: bundled baseline verified; no network required');"
