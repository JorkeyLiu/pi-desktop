# Model management de-specialization: design and bounded plan

- Status: Proposed design and implementation plan. Not implemented.
- Date: 2026-11-12
- Baseline: `03d41de43`
- Scope: model-management metadata acquisition, provider/model association,
  matching, informational enrichment, runtime limit policy, compatibility.
- Out of scope: protocol/auth adapter rewrite, host-core storage ownership, and
  image transport. The image-transport change is already implemented separately
  (ADR 0334).

This is a target design, not an accepted ADR or proof of implementation. Later
behavior changes need their own tests and, where observable, a spec/ADR update.

## 1. Decision summary

1. No manually maintained model-ID, family, or provider-brand alias rules in management.
2. Three separate domains: endpoint availability, endpoint serving facts, upstream canonical references. No synthetic merged record.
3. Provider identity is opaque and explicit: id, upstream API/endpoint, auth. Exact normalized URL associates a published provider only when exactly one matches.
4. Matching is deterministic and reports method/source/fetchedAt plus matched/unmatched/ambiguous. Missing metadata is valid.
5. Acquisition is bounded: non-blocking startup, known-good cache, versioned schema, conditional fetch, byte cap, timeout, atomic write, no public-source credentials.
6. Runtime policy is separate from informational metadata; numeric fields map at the adapter boundary with a named fallback, and unknown is never fake zero or free price.
7. `ModelBinding`/IPC/Plugin SDK stay additive-compatible; stored ids, auth, API settings, and overrides are unchanged.
8. Alias/regex/borrowing code is removed only after consumer migration; protocol routing migrates explicitly, never by brand.

## 2. Current behavior and why it is specialized

All references use the baseline commit and abbreviate package paths: Electron
main files are in `apps/desktop/electron/main/` (`ipc/` for `provider-ipc.ts`),
shared files in `packages/shared/src/`, runtime files in
`packages/agent-runtime/src/`, host files under `crates/host-core/src/`,
`settings/provider-copy.ts` under `apps/desktop/src/components/`, and
`06-release-runbook.md` under `docs/spec/06-delivery/`.

| Area | Current behavior | Evidence |
| --- | --- | --- |
| Discovery | Live probe, then full catalog, then configured fallback. A failed endpoint can still produce `source:"catalog"` rows. | `provider-ipc.ts:629-700` |
| Provider identity | Exact API-URL match, hardcoded known URLs, key aliases, unique-host guess. | `models-dev-catalog.ts:1574-1599,1603-1633` |
| Matching | Exact/leaf matches plus suffix reduction, cross-publisher borrowing, official preference, relay ownership, canonical translation. | `models-dev-catalog.ts:1633-1870`; `types/models.ts:60-121` |
| Alias tables | Hand-maintained provider, publisher, family, brand, responses-only lists. | `models-dev-catalog.ts:442-445,593-714`; `pi-model-metadata.ts:7-46` |
| Source | In-memory refresh: 10 s timeout, no byte cap, no ETag/disk, structural parse only. | `models-dev-catalog.ts:38-39,1493-1543,520-550` |
| Bundle | Read-only release snapshot, manually refreshed. | `index.ts:273-278`; `06-release-runbook.md:142-151` |
| Runtime | Limits required; generic unknown seeds 128k/8192; binding caps unconditional. | `thinking-level.ts:68-69`; `model-capabilities.ts:91-189,234-257` |
| Binding | Required `u32`; `0` sentinel rewritten to 128k/8192. | `providers/model.rs:146-156`; `providers/catalog.rs:15-16,67-76` |
| Cost | Unknown rates become `unknown`; cost dropped, not free. | `request-usage.ts:7-11`; `agent-messages.ts:73-87` |
| Images | Always carried; catalog/`supportsImages` informational. | ADR 0334; `provider-binding.ts:430-438` |

The code contains a second heuristic identity system layered over the catalog.
This plan removes it from management while preserving protocol/auth adapters.

## 3. Image transport is separate and complete
ADR 0334 removes the image gate: transports always advertise `image`, images
travel within existing bounds, and `supportsImages` no longer decides sending.
Keep it on `ModelBinding` for legacy import/export and display
(`types/models.ts:236`; `settings/provider-copy.ts:46`), but no metadata change
may reintroduce a pinned boolean that gates transport.
may reintroduce a pinned boolean that gates transport.

## 4. Three factual domains

| Domain | Answers | Producer | Never used for |
| --- | --- | --- | --- |
| Endpoint availability | Which raw wire ids does this endpoint serve? | Authenticated discovery (`model-discovery.ts:157-195`, `provider-ipc.ts:649-657`) | Public catalog, seeded bindings, another provider |
| Endpoint serving facts | What capacity/modalities/options does this endpoint state? | Endpoint answer and explicit settings | Another publisher's record, family inference |
| Canonical reference | Which published model entity does a reference describe? | Verified models.dev record | Availability, capacity, entitlement |
| Provider identity | Which configured provider, with what API/auth? | Explicit id, URL, auth, `apiStyle`, per-model `api` | Brand, hostname, alias table |

Availability is never inferred from the canonical list. Discovery failure keeps
configured models and reports the failure; it must not label the catalog as
endpoint availability. Manual custom IDs stay allowed. Canonical references may
enrich a served id but cannot create a synthetic row whose capacity pretends to
be endpoint capacity. The transmitted wire id is always raw and never rewritten.

## 5. Provider association

1. Explicit registration is primary: the configured row states URL, auth, and
   protocol.
2. Exact normalized URL may associate a published provider only when exactly one
   published `api` URL normalizes equal (`normalizedApiUrl`/`apiMatches`,
   `models-dev-catalog.ts:720-747`).
3. Zero or several matches leaves identity unknown. An exact canonical id may
   still match globally, but no publisher is claimed.

Forbidden: brand substring/regex, family token, hostname-only matching,
`KNOWN_PROVIDER_BASE_URLS`, `PROVIDER_ALIASES`, relay/publisher family maps,
"supported publisher" tiers.

`PI_VENDOR_ALIASES` (`pi-model-metadata.ts:7-12`, used at
`models-dev-catalog.ts:1562,1745`) selects a pi-ai protocol adapter, not a
metadata identity. Keep it only until explicit provider-identity migration and
never use it for catalog matching.

## 6. Deterministic match algorithm

Per field, return conceptually `{state: matched|unmatched|ambiguous, method,
source, fetchedAt, value?, candidates?}`. Ordered evidence:

1. Explicit canonical reference (future registration; not introduced here).
2. Exact raw wire id in explicit publisher scope; case-sensitive first.
3. Upstream explicit canonical reference declared by the source.
4. Canonical exact id globally; more than one owner is ambiguous.
5. Unique canonical basename/casefold candidate, only when unique globally.
   Case-colliding canonical ids are ambiguous. Casefold only matches; the wire
   id keeps its case.

Never: strip version/date/release/`-latest`/`-thinking`/deployment suffixes
(`models-dev-catalog.ts:1147,1182`); match last path segment across publishers;
borrow another publisher's record; prefer an "official" vendor (`:1015-1035`);
use majority/intersection/median, relay canonical translation, or reseller
capability averaging; infer a provider from a model id.

Each field reports canonical vs endpoint-serving vs explicit-override
provenance. Unmatched/ambiguous fields stay absent; no default value is
fabricated into informational metadata.

## 7. Source acquisition and cache

Electron main owns this service (renderer CSP forbids remote metadata I/O); it
creates no second host database.

- **Startup:** load known-good, paint immediately, refresh in background; network never blocks model listing.
- **TTL:** 24 h initially for canonical metadata; endpoint discovery keeps its per-provider explicit refresh.
- **Bounds:** 15 s timeout, 16 MiB maximum decoded response per document enforced while decoding the streamed body (not only `Content-Length`), bounded JSON size. The cap is a named constant, raised only if a measured legitimate source exceeds it. Oversize/malformed is rejected, never replacing known-good; no automatic unbounded retry.
- **Conditional:** send `If-None-Match`/`If-Modified-Since`; `304` succeeds only with a schema-valid usable cache, otherwise failure, not an empty catalog.
- **Validation:** root/provider/model shapes, types, numeric bounds, ids at the trust boundary. Unknown additive fields may be ignored; invalid known fields reject. Zero providers is failure.
- **Cache file:** `<dataDir>/model-metadata/models-dev-v1.json` — a versioned generic metadata cache name following the existing `<owner>-v<generation>.json` convention, from `data-paths.ts:34-84` like `remote-hosts.json` (`bootstrap/remote-hosts.ts:120`; `12-provider-config-schema.md:500-512`). Atomic `tmp`+`rename`, mode `0600`, schema version/sourceUrl/fetchedAt/validator/optional ETag; corrupt cache quarantined. The cache key is the canonical-source URL plus schema version, never credentials.
- **Versioning:** bump cache schema to invalidate computed metadata only, never user bindings/auth/API/overrides. Verified: the Rust `models` table stores endpoint cases only (`providers/catalog.rs:333-386`); canonical metadata is not persisted there, so no DB migration. A future persisted reference needs migration, `user_version`, and `provider-sync.ts:25-26`.
- **Secrets/policy:** no credentials, auth headers, or cookies to the public source; obey existing proxy/permission/remote-network policy via bounded fetch/route primitives (`mcp-registry-catalog.ts:52-53,174-262`) or Electron `net`.
- **Bundle:** `resources/models.dev/api.json` (`index.ts:273-278`) is optional bootstrap fallback with `bundled@release` provenance, not sole truth. Manual `curl` is current (`06-release-runbook.md:142-151`); `scripts/release.mjs` has no models.dev reference, so no automatic refresh. Stale bundle never outranks a valid disk cache.
- **Canonical vs serving:** no separate `models.json`/serving-facts contract is verified. Current shape is models.dev `api.json` (provider `api` plus models). Do not assume an unverified schema; schema verification is an engineering prerequisite, and until it exists stay with the supported `api.json` source and leave unresolved references unmatched.
- **Concurrency:** single-flight refresh, abort on dispose, generation token so stale results cannot overwrite newer cache.

## 8. Runtime policy and unknown values

| Field | Precedence | Unknown handling |
| --- | --- | --- |
| Images | Explicit attached image travels; no metadata gate | `supportsImages` is legacy metadata |
| Context | Explicit user > endpoint fact > operational fallback (128k) | Canonical reference may warn, but is not silently the hard limit |
| Max output | Explicit user > endpoint fact > operational fallback (8192) | Clamp to effective context; no false `0` |
| Reasoning | Explicit levels/protocol > endpoint-declared option | Unknown means no automatic reasoning; no family regex |
| Cost | Reported > canonical estimate | Unknown is unknown, not free; partial flagged |

The runtime still requires numeric limits (`thinking-level.ts:68-69`) and cost
rates. Unknown maps to a named application fallback at the adapter boundary
(`model-capabilities.ts:234-257,91-189`), not by weakening public types all at
once. Existing precedence and user overrides
(`model-catalog.ts:154-189,238-290`) stay. `clampOutputToContext` already handles
a non-positive window (`output-cap.ts:263-281`).

Overestimate handling: when the fallback is used and a canonical reference
states a smaller window, present provenance through the existing model metadata
line and help affordance: the endpoint did not state a window, the app uses its
fallback, and long requests may fail at the provider. No mandatory new badge,
modal, dashboard, or provider-behavior promise. Compaction uses the effective
number (`context-budget.ts:108-141`); provider errors stay visible and
recoverable.

Reasoning requires explicit user configuration or an endpoint/protocol fact.
Unknown reasoning auto-enables no parameters and invents no supported levels;
explicit user settings and protocol-valid options are preserved. Remove
family-derived reasoning (`anthropicThinkingFor`, `models-dev-catalog.ts:1979-1995`;
`pi-model-metadata.ts:20-46`). A selected adapter may still force a wire shape;
that is explicit configuration.

## 9. Compatibility and persistence

- **Binding:** keep `id`, `alias`, numeric limits, provenance markers, thinking
  fields, and `supportsImages`/`supportsDocuments` as declared
  (`types/models.ts:213-257`; `providers/model.rs:122-173`). Unknown is internal
  resolver state, not a persisted required field; `0` stays for legacy load.
- **User data:** ids, auth, API style, base URL, overrides unchanged; no mass
  rewrite or automatic DB migration. A later persisted reference must be
  additive, added to `MODEL_FIELDS` (`provider-sync.ts:25-26`), with migration
  and version bump.
- **IPC:** `ModelInfo` required fields stay required (`types/models.ts:307-353`);
  provenance/unmatched state is additive optional data through the decoration
  adapter (`provider-ipc.ts:394-471`).
- **Plugin SDK:** `models` stays required, limits stay optional-positive
  (`plugin-sdk/src/index.ts:1954-1964`). No plugin-contract redesign.
- **Protocol:** endpoint decides protocol, not a model id
  (`provider-endpoint.ts:12-22`; `catalog_model` reserved, never emitted at
  `:52-66`). Per-model `api` pins stay explicit. A formerly inferred API migrates
  only by explicit one-time resolution with storage audit and user confirmation;
  never a silent request-mode change or brand fallback.
- **History:** usage/ledger rows and transcripts are not reinterpreted. Unknown
  cost stays unknown; no historical row becomes retroactively free.

## 10. Proposed removals from model management

Only after phase 2/3 migration; not blind deletion of protocol connectors.

| Symbol | Location | Disposition |
| --- | --- | --- |
| `RESPONSES_ONLY_MODEL_IDS` | `models-dev-catalog.ts:442-445`, use `:470-475` | Remove after explicit API migration |
| `KNOWN_PROVIDER_BASE_URLS` | `models-dev-catalog.ts:593-620` | Remove; exact URL + uniqueness instead |
| `PROVIDER_ALIASES`/`providerKeyCandidates` | `models-dev-catalog.ts:622-660` | Remove from management |
| `RELAY_OWNER_ALIASES`/`relayOwnerKeyTiers`/`SUPPORTED_PUBLISHER_KEYS` | `models-dev-catalog.ts:664-714` | Remove |
| `RELAY_FAMILY_PUBLISHERS`/`relayFamilyPublisher` | `pi-model-metadata.ts:20-46` | Remove from management |
| `OFFICIAL_PROVIDER_FAMILIES`/`isOfficialSourceProvider` | `models-dev-catalog.ts:1015-1035` | Remove official preference |
| `sameModelSpelling`/`borrowPool`/`candidateKeys` | `models-dev-catalog.ts:995-1009,1135-1205,1784-1808` | Remove; exact canonical id only |
| `modelForDeploymentMarker`/suffixes | `models-dev-catalog.ts:1706-1782`; `pi-model-metadata.ts:49-61` | Remove; preserve raw id |
| `unanchoredOwnerRecord`/canonical translation | `models-dev-catalog.ts:1835-1975` | Remove |
| `anthropicThinkingFor`/`PI_VENDOR_ALIASES` use | `models-dev-catalog.ts:1979-1995`; `pi-model-metadata.ts:7-12` | Remove inference; transport mapping pending migration |

Not removed: provider presets, auth adapters, per-model API pins, OAuth
entitlement discovery, proxy policy, transcript compatibility, plugin provider
handling. Those are explicit protocol/auth/transport facts.

## 11. Phases and dependencies

Each phase is buildable and testable; no phase ships a permanent second resolver.

- **Phase 0 — image transport.** Already done independently; do not duplicate.
- **Phase 1 — source service/cache.** Bounded fetch (16 MiB decoded, 15 s,
  24 h TTL), validation, versioned disk cache, conditional fetch, provenance,
  known-good. No consumer change. Depends on confirmed payload shape; the cap
  moves only from a measured legitimate need. Acceptance: cache tests pass;
  failure keeps prior data; no credentials; no SQLite change.
- **Phase 2 — source-aware resolver, side-by-side.** Read-only differential
  harness against the current lookup over fixtures and captured endpoint samples;
  no user-visible switch. Removal criteria: every difference is a documented
  heuristic false positive or reported ambiguity; no fixture loses a valid exact
  match; no invented availability. Then switch consumers and remove the old path
  in phase 4 — not keep both.
- **Phase 3 — runtime/UI consumers.** Map unknown at the adapter boundary;
  preserve precedence, usage, cancellation, overrides. Update Settings hints
  unobtrusively; public required fields stay. Depends on phase 2.
- **Phase 4 — remove heuristics.** Delete section 10 tables after no consumer
  imports them. Depends on phases 2/3. Acceptance: no management path reaches an
  alias table; a targeted guard prevents reintroduction.

## 12. Mechanical anti-regression

- Resolver fixtures: ambiguous URLs/canonical ids, case collisions,
  case-sensitive wire ids, publisher scope vs global canonical, deployment-like
  and version/date suffixes preserved, no cross-publisher borrow.
- Source tests: fresh fetch, valid `304`, `304` without cache, stale
  serve/refresh, corrupt/unsupported version, oversize, bad schema, concurrent
  refresh/dispose, no credentials in request.
- Discovery failure: configured models and custom IDs remain; failure reported;
  catalog never labeled endpoint availability.
- Runtime: unknown still emits raw wire id and image blocks unchanged; fallback
  labeled and clamped; unknown cost never free; no family-regex reasoning.
- Compatibility: `ModelBinding`, `ModelInfo`, Plugin SDK manifests, and
  `provider-sync` accept existing shapes; old rows load unchanged.
- Target guard (e.g. `scripts/check-architecture.mjs` or a dedicated check):
  management modules do not reintroduce model-ID/brand/provider alias tables;
  it must not ban explicit protocol connectors elsewhere.

## 13. Tradeoff

Lower inferred match coverage is accepted for source fidelity. A gateway's
reseller-specific id may stay unmatched instead of borrowing a publisher's
limits; it still runs with the raw id and operational fallbacks, not hidden or
blocked. A future explicit "reference model" link could recover coverage
manually, but this plan does not invent that setting.

- `docs/adr/0134-models-dev-sole-model-metadata-source.md:24-30` claims the
  release script fetches/replaces `models.dev/api.json`, but `scripts/release.mjs`
  has no models.dev reference. Manual `curl` is actual practice
  (`06-release-runbook.md:142-151`). Treat the bundle as manually refreshed.
- `models` has an unused `max_output_tokens` column; writer/reader use only
  `context_window` (`db/schema.rs:74-85`; `providers/catalog.rs:284-386`). No
  migration is added merely to populate it.
- A separate models.dev canonical document/schema is not verified; not assumed.
- Image-transport worktree changes are independent; this plan neither duplicates
  nor edits them.

## 15. Chosen design recommendations (implementation unperformed)

These are the recommended defaults for implementation, not open product
questions. Re-open a decision only if implementing it proves a public contract,
persistence format, or architecture behavior must actually change.

1. **Fallback provenance surface.** Present operational-fallback/staleness
   through the existing model metadata and help affordance. No mandatory new
   badge or status widget.
2. **Unknown reasoning.** No auto-enabled reasoning parameters and no invented
   supported levels. Explicit user settings and protocol-valid options are
   preserved; unknown never becomes a family-based guess.
3. **Canonical endpoint schema.** Verifying any canonical endpoint schema is an
   engineering prerequisite, not a product decision. If it is unavailable or
   unverifiable, stay with the supported `api.json` source and leave
   unresolved references unmatched.
4. **Source bounds and cache.** Initially: 16 MiB maximum decoded response per
   document, 15 s timeout, 24 h TTL, and a versioned generic metadata cache
   filename following existing naming convention. Bound decoded body while
   streaming, not only by `Content-Length`. Cache key is canonical-source
   URL + schema version; never credentials. The byte cap is a named constant
   raised only if a measured legitimate source exceeds it; no automatic
   unbounded retry.
5. **DTO and migration surface.** Additive DTO field names and the migration
   confirmation UI are implementation details under existing contract
   constraints. Existing configured API/request mode stays unchanged and
   metadata-cache updates require no permission flow.
6. **Bundle and failure behavior.** Keep the bundled snapshot as a clearly
   labeled bootstrap fallback; on network failure retain last-known-good. No
   manual model-specific updates are required.

## 16. Overall acceptance for the future implementation

- Three domains separate; no synthetic merged record.
- Provider association never uses brand/host/alias tables.
- Every match reports method/source/fetchedAt and unmatched/ambiguous.
- Discovery failure preserves configured data and reports failure without
  catalog availability.
- No false zero/unknown values or free prices in informational or usage records.
- Runtime precedence and cancellation/usage semantics unchanged except the
  documented fallback.
- Existing `ModelBinding`, IPC, Plugin SDK, and stored configuration compatible.
- Obsolete management tables removed; a targeted guard prevents return.
- Focused tests and relevant E2E pass with tested source, base, result, and
  environment recorded.
