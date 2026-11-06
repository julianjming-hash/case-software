import { validateCaseDocument } from './case-document.mjs';
import { validateBuilderDocument } from './builder-document.mjs';
/**
 * Runtime admission never uses preservation diagnostics or a repaired graph. Schema 3 (slides, CASE-214) is admitted
 * only when the caller injects `validateSlides` (slide-document.mjs `validateSlideParts`); without it it fails closed.
 */
export function validateRuntimeDocument(document, { validateSlides = null } = {}) {
  const version = document?.schema_version;
  return version === 2 || (version === 3 && typeof validateSlides === 'function')
    ? validateBuilderDocument(document, { metadata_version: 1 }, { mode: 'ready', ...(version === 3 ? { validateSlides } : {}) })
    : validateCaseDocument(document);
}
