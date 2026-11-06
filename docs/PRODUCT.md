---
doc: CASE-PRODUCT
status: living
purpose: Interface design context for Case, derived from the authoritative handoff and Julian's confirmed facilitator simplification direction.
read_when: Designing or simplifying a served Case interface.
---

# Product

## Register

product

## Users and purpose

Case is facilitator-led clinical decision theatre for ICU, ED and anaesthetic teaching. A registrar controls a shared evolving patient and authored path; participants commit privately; the projector displays revealed material only. Roles, authority and the full product contract remain in [HANDOFF.md](./HANDOFF.md) and [PERMISSIONS.md](./PERMISSIONS.md).

## Brand and references

The canonical design document is the [HTML design system](../prototypes/design-system.html), approved by Julian as the v2 contract on 2026-10-06 and reaffirmed on 2026-10-09. Read it before any UI audit, plan or implementation. Its token/component/art sources are listed on the page; the surface mockups (private historical reference; not distributed) and surface specification (private historical reference; not distributed) provide supporting context. Check the page's status against the current shipped sources before claiming a specimen is deployed.

The HTML file is the design authority. A missing `DESIGN.md` does not mean this project lacks design guidance and must not trigger a replacement or a competing Markdown design system. UI plans must cite the HTML contract and identify any proposed departures for Julian to decide.

Use iatrogenic's versioned design language as Case's existing contract, never runtime sibling code. Preserve the shared tokens and text-only rendering. The interface serves the teaching session, with clear, plain action labels and little additional explanation.

## Anti-references

The product is not a generic quiz, leaderboard or solo virtual-patient simulator (HANDOFF). Avoid tutorial-dependent controls, competing startup actions, click-induced movement and repeated explanatory copy (Julian, 2026-10-07).

## Design principles

The [ten principles in the canonical HTML design system](../prototypes/design-system.html#principles) and [product lexicon in HANDOFF](HANDOFF.md#product-lexicon) are the current owner-approved homes (CASE-353, 2026-11-03). The duplicated principle/disclosure summary here is superseded on 2026-11-03; source values, component specimens and the existing Outline-chip exception remain with their established contracts. This page provides product context rather than a parallel manifesto.

## Accessibility and inclusion

Retain the existing keyboard, focus, contrast, reduced-motion and responsive acceptance checks. Controls must remain usable on facilitator phones and computers; participants need a deliberate desktop layout as well as the phone layout. Room capabilities and unrevealed material remain isolated under the existing permission contract.


## Approved Builder study (CASE-206/207)

The portable Round4 study (private historical reference; not distributed) is the approved visual reference for the future Builder: compact thumbnail Outline, learner canvas, contextual formatting, tabbed inspector and private notes beneath. Spec BWR19 (private historical reference; not distributed) applies existing colours by purpose: petrol editing/selection, violet private tools, coral consequences/removal and amber review. Labels/shapes/states carry the same meaning. This is a design reference; shipped authoring stays unchanged until verified implementation.

CASE-207/BWR20 prioritises authored observations/investigations tables, exact values/units, scoped headers and explicit structure editing; wider labelled callout tones and Turn into retain content/bindings through reviewed transactions. The study and cards refine future work, not shipped capabilities.

CASE-275: Free-text answers join the closed anonymous projector results, up to twelve short response chips per page (500 characters combined) controlled by the facilitator. The phone explains this before Send. A sole available route starts selected in review; explicit Reveal still controls progression.
