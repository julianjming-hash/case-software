---
doc: CASE-LEGACY-DECISIONS
status: evolving
purpose: Selected technical contract witnesses from private history, not a migrated decision history.
read_when: Reviewing the software candidate.
---

# Legacy technical witness

Source commit: 3110c19d608081ff13ba6799b3cf037480d1d08c. Only the existing contrast exception is quoted here. No omitted decisions are fabricated.

| ID | Date | Decision | Rationale |
|---|---|---|---|
| CASE-115 | 2026-10-01 | Recorded exception: the yellow option mark (`Yellow circle`, a true yellow #f2b705) carries a WHITE glyph, like every other mark, although white on that yellow is under the 3:1 non-text minimum (WCAG 1.4.11). The mark stays identifiable by its shape, its colour name in text and the full option label beside it, and a dark edge keeps the mark itself at 3:1 against every background. The contrast gate carries this as the named allow-list entry `yellow-mark-white-glyph` citing this row; it fails if the pair ever passes (a stale entry) or if any other pair falls short. | Julian: a dark glyph on the yellow tile read as a different family of mark; one white-glyph set is the clearer system, and the shape and text already carry the meaning. |
