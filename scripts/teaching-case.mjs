// Validate/edit/export native teaching-case pairs. JSON remains the sole content authority.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { validateSlideParts } from '../src/shared/slide-document.mjs';
import { validateRuntimeDocument } from '../src/shared/runtime-document.mjs';
import { validateBuilderProvenancePaths } from '../src/shared/builder-provenance.mjs';
import { createBuilderTransferExport, parseBuilderTransfer, inspectBuilderTransfer, verifyBuilderSourceHashes } from '../src/shared/builder-transfer.mjs';

export async function validateTeachingPair(document, metadata) {
  const preserve = validateBuilderDocument(document, metadata, { mode: 'preserve', validateSlides: validateSlideParts });
  const ready = validateBuilderDocument(document, metadata, { mode: 'ready', validateSlides: validateSlideParts });
  const runtime = validateRuntimeDocument(document, { validateSlides: validateSlideParts });
  const provenance = validateBuilderProvenancePaths(document, metadata);
  const hashes = await verifyBuilderSourceHashes(metadata);
  return { ok: preserve.ok && ready.ok && runtime.ok && provenance.length === 0 && hashes.ok, preserve, ready, runtime, provenance, hashes };
}

export async function exportTeachingPair(document, metadata) {
  const validation = await validateTeachingPair(document, metadata);
  if (!validation.ok) return { ok: false, validation };
  const exported = await createBuilderTransferExport({ document, metadata, intent: 'copy', includePrivate: true,
    includeSources: true, sourceIds: (metadata.sources ?? []).map(source => source.id), includeProvenance: true,
    includePreparationRequirements: true, includeLineage: Boolean(metadata.lineage) });
  if (!exported.ok) return { ok: false, validation, exported };
  const parsed = parseBuilderTransfer(JSON.stringify(exported.envelope));
  if (!parsed.ok) return { ok: false, validation, parsed };
  const inspected = await inspectBuilderTransfer(parsed.envelope, { mode: 'ready', acknowledgeRedactions: true });
  const exact = inspected.ok && JSON.stringify(inspected.candidate.document) === JSON.stringify(document)
    && JSON.stringify(inspected.candidate.authoring_metadata) === JSON.stringify(metadata);
  // Root-key order is serializer-owned; compare full JSON structures after stable key ordering.
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const semanticExact = exact || (inspected.ok && JSON.stringify(stable(inspected.candidate.document)) === JSON.stringify(stable(document))
    && JSON.stringify(stable(inspected.candidate.authoring_metadata)) === JSON.stringify(stable(metadata)));
  return { ok: Boolean(semanticExact), validation, exported, inspected, semanticExact };
}

async function main() {
  const [action, stem] = process.argv.slice(2);
  if (!['check', 'export'].includes(action) || !stem) throw new Error('Usage: node scripts/teaching-case.mjs check|export <native-file-stem>');
  const document = JSON.parse(await readFile(`${stem}.document.json`, 'utf8'));
  const metadata = JSON.parse(await readFile(`${stem}.metadata.json`, 'utf8'));
  const result = action === 'export' ? await exportTeachingPair(document, metadata) : await validateTeachingPair(document, metadata);
  if (!result.ok) { console.error(JSON.stringify(result, null, 2)); process.exitCode = 1; return; }
  if (action === 'export') await writeFile(`${stem}.transfer.json`, JSON.stringify(result.exported.envelope, null, 2) + '\n');
  const validation = result.validation ?? result;
  console.log(JSON.stringify({ ok: true, schemaVersion: document.schema_version, transferVersion: result.exported?.envelope.transfer_version,
    semanticExact: result.semanticExact, warnings: Object.fromEntries([...new Set(validation.ready.warnings.map(issue => issue.code))].map(code => [code, validation.ready.warnings.filter(issue => issue.code === code).length])), remainingIssues: validation.ready.remainingIssues, excluded: result.exported?.preview.excluded,
    bytes: { document: validation.ready.bytes, metadata: validation.ready.metadataBytes, transfer: result.exported?.preview.byteLength } }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
