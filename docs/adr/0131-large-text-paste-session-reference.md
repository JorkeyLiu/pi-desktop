# ADR 0131: Spill Large Composer Text Pastes into Session Scratch

- Status: Accepted
- Date: 2026-08-28
- Deciders: PI-Desktop core
- Related: Issue #20, D262, ADR 0059, ADR 0070, ADR 0124

## Context

Native textarea paste is useful for short prompts, but very large pasted
blocks make the composer difficult to edit and inflate the visible prompt. The
application already has a bounded Electron-to-main paste bridge and a
session-owned scratch directory for clipboard files. The solution must preserve
the exact pasted bytes, work when the caret is in the middle of a draft, avoid
mutating the project, and keep the model-facing prompt addressable by the
existing `@path` file semantics.

## Decision

1. Add the persisted `largePasteThreshold` app setting. It defaults to 600
   characters and accepts integer values from 1 through 1,000,000. Text-only
   pastes at or below the threshold retain native textarea behavior.
2. A text-only paste above the threshold is intercepted by the Composer and
   sent through the existing `composer/pasteFiles` bridge as one UTF-8
   `text/plain` file. Electron main validates the durable session and stores
   it under `<data_dir>/scratch/<sessionId>/pasted/` using the existing bounded,
   sanitized, unique-file policy.
3. The Composer inserts `@<temporary-name> ` at the original selection and
   stores a renderer-only token-to-canonical-path mapping with the draft. The
   token remains visible inline, so the prefix and suffix of an existing draft
   remain editable. It is resolved in place exactly once immediately before
   dispatch; it is not appended as a second reference and is not included as a
   duplicate structured attachment.
4. The mapping remains session-scoped, survives project/workspace switches for
   its owning session, participates in draft caching and unanswered smart-Stop
   restoration, and is removed when the token is removed from the text. Session
   scratch lifecycle and cleanup remain the existing host-owned behavior.
5. Clipboard files and images keep their existing compact chip and structured
   attachment flow. This decision changes only text-only pastes above the
   configured threshold.

## Consequences

- Large pasted blocks no longer occupy the editable prompt body; the user sees
  a compact, addressable reference at the exact paste position.
- The agent can read the exact saved bytes through the canonical scratch path,
  while the project tree, artifact store, and host protocol schema remain
  unchanged.
- The setting is backward-compatible because older app settings gain the
  default through host normalization rather than a database migration.
- The renderer must retain a small amount of draft metadata to distinguish a
  generated inline token from user-authored `@` text and to avoid duplicate
  serialization.

## Alternatives considered

- **Keep all text inline:** rejected because large blocks remain difficult to
  edit and unnecessarily enlarge prompt content.
- **Write directly into the workspace:** rejected because a paste is transient
  input and must not dirty the user's project.
- **Use a chip only:** rejected because the requested affordance is an inline
  reference at the paste location, and the surrounding draft must remain
  readable.
- **Send the token as a basename or append a second path:** rejected because
  scratch files require their canonical path and either option can be
  ambiguous or duplicate the same input.

## Amendment (2026-09-14): text representation selected beside generated image copies

ADR 0059's #138 amendment can select a text representation for a paste that also
carries `image/*` copies, which is what Word supplies for a copied selection.
That selected text uses this decision's `largePasteThreshold`, so short text
stays editable inline and larger text spills into session scratch as before. The
clipboard-file and image flows of decision 5 are unchanged.

## Amendment (2026-11-07): the paste travels as prompt text, not as a path to read

Decision 3's canonical path stays the durable, display-facing form of an
automatically converted paste, but the turn that sends it now carries the text
itself. The reference-only model is replaced for these files:

- Storage states the provenance. The Composer marks its oversized-text payload
  with the optional `origin: "auto-text"` transport field, and Electron main
  writes such a payload into the session's dedicated
  `<data_dir>/scratch/<sessionId>/pasted/text/` directory instead of
  `pasted/`. A picked, dropped, or clipboard file never sets that field and
  keeps the user's own leaf name under `pasted/`, so no file name can make a
  manual file look like an automatic paste. The field is additive and optional;
  a peer that does not send it simply stores an ordinary file.
- Electron main replaces every plain-text marker that resolves inside that
  owned directory with the file's exact UTF-8 text in the content it hands the
  agent runtime. The first model-visible user message therefore holds the pasted
  words with no Read step and no dependency on a tool the runtime may refuse to
  run outside the workspace.
- The persisted user message, the transcript, and the draft keep the compact
  chip and `@<path>` text. Only the prompt built for the model is rewritten, so
  history does not turn into a paste blob and the display is unchanged.
- The same rule applies to every send path: a new turn, a steer, a queued
  delivery, and a retry. Restored history rebuilds the text from the persisted
  `@path` through the same directory predicate, so a resumed conversation keeps
  the words.
- The rule is scoped to that directory. An `@path` the user typed, a picked,
  dropped, or pasted file, a workspace file, another session's paste, and a
  symlink that leaves the owned directory are never read.
- A paste file that cannot be read, changed while the turn was prepared, or
  exceeds the paste byte bound fails the send with a coded error instead of
  sending a path in place of the words. Nothing is silently truncated. A session
  scratch directory removed by the retention sweep is the same visible failure,
  not a quiet fall back to the path.
- The pasted text is restored after the draft's own surrounding whitespace is
  trimmed, so the pasted bytes keep their leading blank lines, indentation, and
  trailing newline while the established treatment of what the user typed is
  unchanged.

### Legacy limitation

A paste saved before this amendment sits directly in
`<data_dir>/scratch/<sessionId>/pasted/` with nothing but its name to identify
it, and that name is shared with files the picker, drag-and-drop, and clipboard
files can produce. Those references stay reference-only: origin cannot be
established safely, and preserving the behavior of user-selected files takes
precedence over hydrating an older paste by guessing from its name.
