#!/usr/bin/env bash
# Qualify this offline compatibility baseline under real macOS /bin/bash 3.2 as well as Linux.
# Compatibility entrypoint: validates the bundled baseline; never fetches.
set -euo pipefail
node --input-type=module -e "import {archiveLegacySource} from './tests/helpers/legacy-source.mjs'; archiveLegacySource(process.cwd()); console.log('legacy source: bundled baseline verified; no network required');"
