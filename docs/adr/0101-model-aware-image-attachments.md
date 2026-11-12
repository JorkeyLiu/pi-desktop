# ADR 0101: Model-aware image attachment transport

- Status: Amended (transport and capability-gating clauses superseded by
  [ADR 0334](0334-explicit-image-transport-metadata-informational.md))
- Date: 2026-08-18
- Deciders: PI-Desktop runtime and desktop UI maintainers
- Amends: D197, ADR 0059, ADR 0070
- Amended by: D361 (inline bound is 10 MB, matching MiniMax's OpenAI-compatible cap), D392 / ADR 0218 (binding image-input overrides), ADR 0334 (explicit images always travel; metadata stays informational)

> **Transport superseded by ADR 0334.** Decisions 2, 4, 5 and the transport
> half of decision 6 below are historical: an explicit user image is inlined
> within the per-image bound regardless of catalog or binding capability
> metadata, over-size/unreadable bytes fail visibly instead of becoming
> `@path`, and restored history follows the same rule inside its aggregate
> budget. The storage boundary, validation roots, content-addressed refs, and
> the 10 MB / 30 MB byte bounds in this ADR remain in force.

## Context

Clipboard images were materialized successfully, but the composer reduced every
file to `@<path>` text. A model that supports image input therefore received a
filesystem reference instead of an image block. The capability signal must be
owned by the same model catalog that pi-ai uses to serialize provider requests;
renderer discovery and user-entered model ids are not sufficient evidence.

## Decision

1. Keep the composer draft compact and textual. Each file reference retains its
   kind, name, MIME type, and source path as structured metadata; the visible
   textarea never contains pasted binary data.
2. Resolve vision capability from the exact pi-ai model record. Only
   `model.input.includes("image")` enables image transport. Unknown and custom
   model ids stay on the conservative non-vision path, even when discovery
   metadata claims `vision`.
3. Electron main remains the attachment boundary. It validates every source
   path against the session scratch root, the session-bound project root, or
   the content-addressed attachment root. Images are stored as
   `attachments/<sha256>` and the durable `UiMessage` stores only the reference
   and metadata.
4. For a vision-capable model, an image within the 10 MB inline limit crosses
   the sidecar only as transient base64 data and becomes a pi-ai image content
   block. The base64 value is never persisted in SQLite, JSONL, or renderer
   transcript state.
5. For a non-vision model, an unknown model, or an image above the per-image
   inline limit, the prompt receives a safe `@path` fallback. Replayed
   content-store images are copied into the session scratch `replayed/`
   directory before that fallback is exposed to the model.
6. Restored vision history has a 30 MB aggregate raw-image-byte budget in
   addition to the 10 MB per-image limit. The sidecar considers newest
   attachments first, preserving all images when the history fits; older images
   beyond the budget use the safe path fallback. The current prompt row is
   excluded before history hydration so its transient payload does not consume
   the history budget.
7. The Composer shows a compact accessible status row when an image is attached:
   it states whether the selected model can receive visual input. The model
   picker and session/provider summaries expose the same authoritative vision
   capability.

## Consequences

- GPT/vision-capable models can inspect pasted images without requiring a
  model-specific renderer implementation.
- Text-only and non-vision models retain the existing file-tool workflow.
- Image bytes are deduplicated and can survive retry, fork, and runtime
  recreation without putting binary data in the transcript.
- Restored sessions preserve historical vision blocks regardless of age while
  the images fit within one fixed aggregate budget; over-budget history has a
  deterministic memory ceiling and a safe path fallback for older images.
- Attachment garbage collection remains a later storage task; references are
  content-addressed so it can be added without changing the message contract.
- Full visual previews, drag-and-drop, image transforms, and provider-specific
  image limits remain out of scope. The 10 MB inline threshold is an app-side
  safety bound; providers may impose stricter limits and return their normal
  provider error.

## Rejected alternatives

- **Always send `@path` text:** preserves non-vision behavior but cannot satisfy
  vision models.
- **Trust renderer/provider discovery flags:** can advertise a capability that
  the runtime adapter cannot serialize and would make unknown models unsafe to
  classify.
- **Persist base64 in messages:** makes reloads and SQLite/JSONL growth
  unbounded and crosses the persistence boundary unnecessarily.
