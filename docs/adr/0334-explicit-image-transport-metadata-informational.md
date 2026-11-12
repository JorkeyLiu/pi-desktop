# ADR 0334: Explicit images always travel; capability metadata stays informational

- Status: Accepted
- Date: 2026-11-12
- Deciders: PI-Desktop runtime and desktop UI maintainers
- Supersedes: the transport and settings clauses of
  [ADR 0101](0101-model-aware-image-attachments.md) and
  [ADR 0218](0218-effective-image-input-overrides.md); their storage,
  validation, and persistence decisions remain in force.

## Context

ADR 0101 made `model.input.includes("image")` the switch that decided whether
an attached picture became a transient image block or a safe `@path` reference.
ADR 0218 then let a binding's `supportsImages` override that published record
and reused the same effective answer for the Settings switch, the Composer
badge, and main-process transport. The intent was to avoid offering a picture
to a model that cannot serialize one.

That gate is not a reliable description of an endpoint. Published catalog rows
are frequently text-only for gateways, relays, self-hosted deployments, and
newly released models that do accept images; a stale or absent catalog row
therefore silently converted the user's own picture into a file path. The same
happened for an unknown/custom model id, and for a stored `supportsImages:
false` left over from an earlier configuration. The user asked for a model
because of its endpoint, not because a local metadata row agreed with it.

pi-ai decides the final request shape from `Model.input`: when it omits
`image`, `transformMessages` replaces every user and tool-result image block
with an omission placeholder before any adapter builds its payload. Every
inference path that used the catalog projection therefore needed that field to
describe what the request may carry. The earlier delegated-child transport
already forced it (ADR 0299), which left the main chat path as the only one
where a picture could disappear.

## Decision

1. `Model.input` is transport capability, and the runtime always advertises
   `image` for chat transports built by `buildProviderModel`. Published
   modalities, the binding's `supportsImages` value, and unknown/custom ids
   remain metadata on `modelConfig`; they are not mutated to make transport
   work, and they never remove an attached picture.
2. An explicit image the user attached is prepared as transient image bytes
   within the existing per-image 10 MB app bound, for a new prompt, a
   steer/follow-up, and restored user history alike. The image is carried
   whatever the catalog or binding metadata says.
3. The existing history aggregate budget (30 MB raw image bytes) and its
   per-image bound remain. Restored images are inlined in newest-first order;
   images beyond the aggregate budget keep the existing replayed `@path`
   fallback instead of silently growing memory or truncating the budget.
4. Bytes that cannot be carried fail visibly with the existing coded errors:
   an image above the per-image bound fails with `PAYLOAD_TOO_LARGE`, and bytes
   that are not a readable image signature fail with `UNSUPPORTED`. An explicit
   current-turn image is never silently replaced by its path. SVG keeps its
   intentional file semantics (it is not offered as an image block).
5. Tool-result and MCP image blocks follow the same policy: well-formed image
   blocks from a tool are transported as images when the request is built,
   instead of being dropped because capability metadata said text-only.
   Malformed entries remain ignored without failing the tool call.
6. The Settings image-input toggle is removed. It was a sending switch, and a
   sending switch that no longer decides sending would misstate the
   contract. The persisted `supportsImages` field remains accepted for backward
   compatibility and stays informational. The binding's `supportsDocuments`
   value and the document-input checkbox are metadata too: a non-image
   attachment, a PDF included, is prepared as a `kind: file` `@path` reference
   the model reads through its ordinary Read workflow, whatever the value says,
   and no transport path consults it. That control stays untouched here because
   this decision only removes a sending switch that no longer sends; automatic
   catalog/discovery capability collection is unchanged.
7. No protocol, IPC, persistence-schema, or provider-ownership change is
   involved. pi-ai remains responsible for adapter serialization; a provider
   that cannot read a picture returns its ordinary provider error, which the
   runtime surfaces as it does for any other request failure.

## Consequences

- A user's explicit picture reaches every configured chat endpoint, including
  a text-only published row, an unknown/custom model, and a stored negative
  override.
- Capability metadata keeps describing what the catalog publishes, so settings
  and status surfaces do not claim a transport decision they no longer make.
- An endpoint that truly cannot accept an image now answers with a normal
  provider error instead of the app silently sending text; the failure is
  visible and attributable to the endpoint.
- The per-image and history budgets still bound memory; only the metadata gate
  was removed.
- Delegated children and the main chat now share one transport rule instead of
  two parallel ones.

## Alternatives considered

- **Keep the gate and trust catalog metadata:** rejected — it drops the user's
  actual request whenever discovery, the catalog, or an old local override is
  stale, which is common for gateways and custom endpoints.
- **Keep the toggle as "informational":** rejected — a control labelled image
  input that does not govern image input is a false promise. The document
  override stays for a separate reason: no transport path consults it either,
  so removing it is a metadata cleanup outside this image change.
- **Send both the image block and a `@path` note:** rejected — it duplicates
  user content and implies a file fallback the user did not ask for.
- **Raise or remove the byte bounds to make every image inline:** rejected —
  the bounds are app-side memory safety, not capability metadata.

## Verification

- `packages/agent-runtime/src/image-transport.test.ts` captures the real
  OpenAI-compatible request body for text-only metadata, a negative override,
  and tool-result images.
- `apps/desktop/test/image-transport-metadata-gating.test.mjs` runs the
  attachment-preparation → provider model → adapter payload path, plus
  over-size/unreadable visible failures and restored history.
- Updated coverage: `attachment-history.test.ts`, `svg-attachments.test.mjs`,
  `prompt-inline-attachments.test.mjs`, `composer-paste-files.test.mjs`,
  `auto-pasted-text-context.test.mjs`.

## Related

- [03-runtime/02-agent-runtime.md](../spec/03-runtime/02-agent-runtime.md) §5c,
  §6
- [03-runtime/13-model-catalog-and-selection.md](../spec/03-runtime/13-model-catalog-and-selection.md)
  §11
- [04-ux/06-settings-ia.md](../spec/04-ux/06-settings-ia.md) model configuration
- [04-ux/08-component-spec.md](../spec/04-ux/08-component-spec.md) Composer
  model menu and attachments
- [06-delivery/04-e2e-test-plan.md](../spec/06-delivery/04-e2e-test-plan.md)
  E2E-CHAT-image-transport-metadata
