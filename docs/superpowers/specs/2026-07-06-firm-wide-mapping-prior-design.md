# Firm-Wide Mapping Prior — Design

Date: 2026-07-06

## Goal

Push the mapping engine's line-match accuracy past the ~65% ceiling documented in
`docs/VALIDATION_EVIDENCE.md`, which names two specific remaining gaps:

- **New-in-year accounts**: an existing (returning) client opens a ledger
  account never seen in a prior year, so per-client mapping-memory
  (`mapping-memory.ts`) has nothing to replay for it.
- **A brand-new client's first year**: no per-client memory and no prior-year
  return exist at all, so the mapper falls back to generic template-label
  matching / keyword heuristics, which cannot capture **per-firm conventions**
  (e.g. this firm always books "Materials" to CfR code 5600 "Direct Costs",
  while another firm might use a different code for the same wording).

Both gaps are currently absorbed by the preparer-confirm step, which is safe
but doesn't improve the proposal itself. This feature adds a new signal — a
**firm-wide learned prior** — built from mappings this firm has already
confirmed across its *other* clients, so a first-time account gets a smarter
starting proposal instead of a generic guess or a blank row.

## Non-negotiable constraint (unchanged)

No figure on the return is ever produced by AI or by this feature. This
feature only proposes a `(cfrCode, sheet)` **mapping** for an account whose
**amount** already comes straight from the ETB — identical in kind to every
other proposal source already in `mapping.ts` / `mapping-memory.ts`. The
preparer confirms every mapping before generation, unchanged.

## What this builds

A fallback signal that activates only when the existing template-label match
is weak (score below its own confidence threshold) and the keyword heuristic
in `mapping.ts` is silent for an account. It looks at every mapping rule this
firm (the `owner` key already used throughout `mapping-memory.ts`) has
confirmed across **all** of its clients — not just the one currently being
processed — and asks: has this firm consistently sent a similarly-named
account to one specific CfR code before? If at least two *distinct* clients
agree, it proposes that code with an elevated (but capped) confidence.

This is the same "firm's own confirmed choice replayed as fact" philosophy
that already powers per-client mapping-memory and prior-year value
fingerprinting — just widened from "this one client's history" to "this
firm's whole history."

## Data source — no new storage

`mappings.json` (read/written via `mapping-memory.ts`'s `load()`/`save()`)
already stores every confirmed `(ledgerCode, ledgerName, cfrCode, sheet)` rule
per client, per owner, across all years. This feature reads that same file at
proposal time and aggregates across all of the owner's `MappingMemory`
entries — no second learned-model store, no separate persistence path, no
migration. Consistent with the existing "flat JSON, deterministic" approach
used everywhere else in this module.

## Matching algorithm

For an account not already resolved by per-client recall, prior-year value
fingerprinting, or a strong template-label match:

1. Load all `MappingMemory` entries for this `owner` (across every client).
   Flatten to `(ledgerName, cfrCode, sheet, clientName)` tuples.
2. Score the target account's name against every historical `ledgerName`
   using the **existing** `labelSimilarity` function already exported from
   `mapping.ts` (the same Dice-coefficient/token-overlap scorer that powers
   `bestLabelMatch` today) — no new matching logic to write or maintain.
3. Keep tuples scoring `>= 0.7`.
4. Group survivors by `(cfrCode, sheet)`. Take the group with the most
   **distinct** `clientName` values.
5. Propose that `(cfrCode, sheet)` only if:
   - the winning group has `>= 2` distinct clients, **and**
   - its distinct-client count is strictly greater than every other
     `(cfrCode, sheet)` group's count (a tie — e.g. two codes each confirmed
     by 2 distinct clients — is a genuine split with no clear majority, and
     is left unmapped, same philosophy as the existing ambiguous
     value-fingerprint skip in `fingerprintRules`).
6. Confidence: `0.75` base + `0.04` per distinct client beyond 2, capped at
   `0.92`. Deliberately below an exact template-label match (`0.98`) or a
   value fingerprint (`0.99`) — this is a behavioral pattern, not a filed
   fact or a literal label match.
7. Statement routing (`sheetAllowed`) and template-code validity
   (`templateCodes`) still apply exactly as they do for every other proposal
   source — a firm-history hit for a code that doesn't exist on this client's
   template, or that violates the ETB's own PL/BS routing, is dropped.

## Pipeline integration

New function, e.g. `firmHistoryRules(owner, accounts, templateCodes)` in
`mapping-memory.ts`, sitting alongside `recallMapping`/`rememberMapping`.
Called from the mapping flow in `server.ts` (or threaded through
`ai-mapper.ts`, matching how `fingerprintRules` is currently overlaid) **after**
template-label match, keyword heuristics, and AI proposal have all run, and
**after** `recallMapping`'s per-client overlay:

- Only fills accounts still unmapped, or mapped at a confidence below the
  label-match "weak" band (`< 0.6`).
- Never overrides an account already resolved by per-client recall, prior-year
  fingerprinting, or a strong (`>= 0.6`) template-label/keyword hit.
- `recalled` (per-client, same client) and `fingerprintRules` continue to take
  priority exactly as today — this is strictly a new, lowest-priority
  gap-filler.

## UI touch (minimal)

No per-row UI rework. The existing confidence `badge()` in `new-return.html`
already communicates "stronger than a raw guess" via the elevated confidence
value. Add one small banner, styled identically to the existing
`recalledFrom` "↺ Returning client recognised" callout:

> "N account(s) proposed from your own mapping history across other clients."

Server response gains a small count (e.g. `firmHistoryCount`) alongside the
existing `recalledFrom` field for the client to render this banner.

## Testing

Unit tests in the style of the existing `mapping-memory`/`mapping` test
coverage:

1. Seed a fake `mappings.json` (or call `rememberMapping` directly in the
   test) with 2+ distinct clients confirming the same name→code pattern;
   verify a third, new client's similarly-named account is proposed with the
   right `(cfrCode, sheet)` and a confidence in the expected `[0.75, 0.92]`
   band.
2. A pattern confirmed by only **one** client must NOT be proposed (threshold
   not met) — including across that same client's own multiple years (must be
   distinct clients, not repeat years of one).
3. A genuine split — the same name pattern confirmed to two different codes
   across different clients with no majority — must stay unmapped.
4. A firm-history hit must never override an existing strong template-label
   match, per-client recall, or value fingerprint (priority ordering test).
5. A firm-history hit for a `(cfrCode, sheet)` not present in the current
   client's `templateCodes`, or that violates `sheetAllowed`, must be dropped.

## Out of scope (for this feature)

- Literal balance-splitting (dividing one ledger account's amount
  proportionally across multiple CfR sub-lines) — considered and explicitly
  rejected in favour of the cross-client learned-prior approach above.
- Cross-*owner* learning (sharing patterns between different firms/accounts)
  — stays scoped to the existing per-`owner` boundary, matching every other
  memory mechanism in this codebase today.
- Any UI for inspecting/editing the learned corpus directly (e.g. an admin
  view of "firm patterns") — not requested; can be a later addition if
  wanted.
