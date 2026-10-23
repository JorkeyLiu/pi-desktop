# ADR 0332: Built-in First-Message Session Titles

- Status: Accepted
- Date: 2026-10-18
- Supersedes in part: ADR 0323

## Context

A session needs a useful title as soon as its first message is sent, while users
who configure a dedicated fast model can receive a concise model-generated title
without waiting for the first assistant turn to finish. This is a built-in,
optional helper behavior, and must not change the model or permission contract of
the conversation itself.

## Decision

- App settings may contain optional `fastModelProviderId` and `fastModelId`.
  Settings → Models lets the user choose or clear an enabled, configured chat
  model. An absent binding means no fast model is configured; title generation
  must not fall back implicitly to the active conversation model.
- On the first message in an ordinary local session, the renderer immediately
  derives the existing normalized, 48-character prompt fallback. In parallel,
  Electron main may use the configured fast model for one independent,
  one-shot completion based only on the bounded first prompt and replace the
  fallback with a concise title. It does not wait for the assistant's first
  response. Missing configuration, completion errors, or an unusable result
  leave the fallback in place.
- Only the first message triggers title generation. Later messages do not
  rename the session. Remote and Pi-native sessions do not invoke local
  credentials for this feature and retain their existing title behavior.
- Host-core owns title state and applies generated titles with compare-and-set.
  Manual and already-generated titles cannot be overwritten by a stale result.
- The one-shot uses the existing host provider/model execution boundary. It
  receives no transcript, attachments, tools, or plugin-added permissions, and
  does not expose credentials to the renderer. Existing plugin title APIs and
  permissions remain available and compatible; plugins can continue to provide
  their own title behavior under their existing authorization.

## Consequences

- Users get an immediate prompt-derived label whether or not a fast model is
  configured. Configuring a fast model adds asynchronous title refinement.
- The separate fast model is an explicit global setting, independent of the
  active session's selected model.
- Existing manual title ownership and host compare-and-set protection remain
  authoritative. Remote and Pi-native title behavior is unchanged.
- ADR 0323 remains historical for its plugin-owned generation decision and
  permission design. Its prohibition on built-in model title completion and its
  claim that only a plugin may provide model-generated titles are superseded.
  Existing plugins remain supported; this ADR grants them no new capabilities.
