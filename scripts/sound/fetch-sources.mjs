// Optional recovery of the committed, pinned original CC0 recordings. Network authoring tool, never a test.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root=new URL('../../prototypes/sound-stage/sources/',import.meta.url);
const {samples}=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));
for(const sample of samples){const response=await fetch(sample.url);if(!response.ok)throw Error(`${sample.file}: HTTP ${response.status}`);const bytes=new Uint8Array(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==sample.sha256)throw Error(`Source hash mismatch: ${sample.file}`);await writeFile(new URL(sample.file,root),bytes);}
