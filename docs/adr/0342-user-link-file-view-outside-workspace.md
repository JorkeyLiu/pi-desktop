# ADR 0342: User-link file viewing outside the workspace

- **Status**: Accepted
- **Date**: 2026-11-28
- **Deciders**: PI-Desktop maintainers
- **Related**: [ADR 0019](0019-work-panel-subsystems.md) ·
  [ADR 0262](0262-chat-file-refs-open-in-the-file-view.md) ·
  [ADR 0163](0163-transcript-file-reference-chips.md) ·
  [01-ipc-protocol §13a](../spec/03-runtime/01-ipc-protocol.md) ·
  [05-security/01-security](../spec/05-security/01-security.md) ·
  [04-ux/08-component-spec §8.3](../spec/04-ux/08-component-spec.md)

## Context

A chat file reference that names an absolute local path outside the workspace,
the session scratch store, and the attachment store completes today with
`reason: "outside-allowed-roots"`, and the click reports an access limit.
That containment is correct for agent-completed references (D320 / D334 /
D668): the agent, not the user, chose what to name, and the renderer must not
turn agent text into arbitrary local reads.

The user explicitly requested the opposite boundary for their own click: when
the person at the keyboard clicks a local file link in chat, the app opens
that exact file — even outside the workspace — with no second confirmation
and no sensitive-path filtering. The click is the authorization. Agent tools,
plugin filesystem APIs, and ordinary reference completion keep their existing
containment unchanged.

## Decision

1. **A semantically separate user-file capability, not a gesture flag.** Two
   new renderer-facing channels, `pi-desktop/fs/readUserLink` and
   `pi-desktop/fs/saveCopyUserLink`, express "the user opened this file".
   No `userClicked` / `userInitiated` boolean is added to any existing
   channel and none is accepted: a renderer-supplied gesture claim is
   forgeable by definition, so the capability boundary is which channel was
   invoked, not what the payload asserts. Ordinary `fsResolveRef`,
   `fsRead`, `fsReadImageDataUrl`, `fsOpen`, `fsReveal`, and `fsSaveCopy`
   keep their exact current behavior and containment.
2. **Main-window exclusivity.** Both channels register with `handleWithEvent`
   plus `assertMainWindowSender` (the same main-window gate other
   renderer-only channels use). Plugin panel / widget `WebContents` go
   through the separate `pi-plugin-panel-invoke` bridge and can never satisfy
   the sender check, so plugins cannot invoke the user-link capability.
   The preload exposes no new generic surface: the two channels join the
   existing `IPC_WHITELIST`-gated `invoke`, with narrow `api.fsReadUserLink`
   / `api.fsSaveCopyUserLink` renderer methods as the only callers.
3. **Local sessions only.** A remote (`remote-project:` / SSH) owning
   session rejects with `INVALID_ARGUMENT` and never falls back to reading
   the local disk: a remote path is display data, never a local open. The
   renderer also lists both channels in its remote-invocation guard as
   defense in depth.
4. **Absolute regular files only, resolved before read.** The path must be an
   absolute path on the local platform (`node:path.isAbsolute`: POSIX root,
   Windows drive or UNC on Windows). `~`, empty, NUL-containing, relative,
   and shorthand tokens are rejected, never guessed. The host `realpath`s
   the path, opens the result, and `fstat`s the open fd: directories,
   FIFOs, sockets, and block/character devices are refused. A symlink is
   followed exactly as the user asked — the read addresses the realpath
   target — and the final target must still be a regular file. The fd-backed
   check replaces the `stat`-then-`read` race for the file-kind verdict;
   the residual rename window between `realpath` and `open` can only swap
   one regular file for another and is documented here rather than claimed
   away. No sensitive-directory or content deny list is consulted: resource
   caps are not content filtering. Renderer tab state keeps a Windows-absolute
   user-link spelling verbatim instead of segment-normalizing it, so a UNC
   `\\` prefix survives open-persist-restore.
5. **Preview classification and resource caps are reused.** The user-link
   read classifies through the same `previewFile` table as the contained
   readers: text (≤512 KiB), image data URL (≤5 MiB, same
   `VIEWABLE_IMAGE_MIME` extension-wins rule), `binary`, and `tooLarge`.
   These are resource bounds, not content judgments.
6. **Save-a-copy re-validates through the same gate.** The user-link
   download opens the OS save dialog and copies bytes; it re-resolves the
   source path through the same realpath-plus-regular-file gate and never
   writes bytes the renderer supplied. External open (`shell.openPath`) and
   reveal are not offered for user-link files: the buttons are hidden
   instead of calling the contained channels and failing there.
7. **Converged call surface.** `useOpenChatFileRef` routes to the user-link
   entry only when `fsResolveRef` answers `outside-allowed-roots` for an
   absolute-path token; missing, relative, and shorthand tokens keep their
   current lookup and error behavior with no speculative guessing. The files
   tab gains an explicit internal user-link mode, set only by that entry
   (carried on the file tab through `fileRequest`, including restore), which
   selects the user-link read/save channels and hides open/reveal.
   Structured attachments, Markdown images, HTML/browser routing, and URL
   handling are untouched.
8. **Accurate errors.** A path that exists nowhere reports missing
   (`NOT_FOUND`); an existing non-regular file reports not-a-regular-file;
   remote ownership and read failures report their own verdicts. The
   `fileRefRestricted` copy is no longer shown for a path the user is
   authorized to view.

## Trust assumptions

- The click reaching Electron main through the main-window `WebContents`
  represents the user at the keyboard. This is the same trust position the
  composer picker token (D344) and the save dialog already take: the OS
  window and its input belong to the user.
- Agent output, tool results, plugin content, MCP responses, and file bytes
  in the transcript are untrusted data. They may *name* a path; they never
  authorize a read. Authorization happens only when the user clicks and only
  through the user-link channels, which agents and plugins cannot invoke.
- The local filesystem layout (which absolute paths exist) is the user's own
  machine, not a secret the app keeps from the user.

## User capability vs. agent capability

- The user-link channels are unreachable from agent tools, the plugin SDK
  filesystem surface, and the agent sidecar: no tool schema, plugin API, or
  host RPC maps to them, and the sender gate rejects non-main-window
  callers. A mechanical test asserts agent/plugin sources never reference
  the new entry points.
- Agent containment (`fs/read` roots, chat-ref completion roots, tool
  permission layer, Plan/Goal denials) is byte-for-byte unchanged. An agent
  naming `/etc/passwd` in prose still resolves to nothing and still reads
  nothing; only the user's click on a chat file link opens it, in the user's
  own preview surface, never in the agent's context.
- Entry surfaces are separated inside the renderer: the chat file-ref opener
  (`useOpenChatFileRef`: message chips and links) routes an absolute
  outside-roots click to the user-link channels, while the tool-row opener
  (`useOpenPreviewTarget`: agent tool summaries and results) passes
  `allowUserLink: false` and keeps the `fileRefRestricted` report. A click on
  a tool row is still a click, but the path it names was chosen by the agent,
  so it authorizes nothing. This is an internal call-surface option, not an
  IPC gesture credential: the capability boundary stays which channel was
  invoked, and the tool entry never invokes the user-link channels.

## Known risks when the renderer is compromised

- A compromised renderer running in the main window can invoke the user-link
  channels with arbitrary absolute paths and exfiltrate regular files within
  the text/image caps through its own network. This is inherent to granting
  the user's own file views: the same compromised renderer can already read
  every file the user opens through contained channels and every byte the
  agent legitimately retrieved. The user-link channels do not extend what a
  renderer-level attacker can reach beyond "files the user could click",
  which on a single-user desktop is the user's readable filesystem.
- Mitigations that remain: no silent bulk interface (one path per invoke,
  dialog-gated save destination), no execution (`openPath` unreachable),
  no directory enumeration (no user-link list channel), and no remote
  bridging (a compromised renderer cannot pivot a remote session into local
  reads through these channels).
- The residual `realpath`-to-`open` swap window (above) is accepted: the
  worst case is reading a different regular file, never a device or socket,
  because the fd `fstat` verdict is authoritative for the bytes returned.

## Remote limits

- Remote-owned sessions reject on both channels before any filesystem
  access. There is deliberately no "read the local path with the same name":
  remote paths name files on the remote host. The renderer hides behind the
  same rule and never sends remote-owned clicks to these channels.

## Migration and compatibility

- No host protocol version bump, no storage schema change, no plugin SDK
  change. Existing channels are additive-only; old renderers never call the
  new ones and new mains still serve old renderers on every old channel.
- Nine shipped locales gain three user-link error strings; `fileRefRestricted`
  stays for genuinely restricted surfaces (reveal/copy of outside paths,
  agent-completed refusals). No changelog entry: this is not a release
  (release runbook, D164/D345).

## Alternatives considered

- **A `userClicked: true` flag on `fs/read`.** Rejected: any renderer,
  including a plugin-injected script or a compromised page, can set a
  boolean. The channel itself must be the capability.
- **Widening `fs/read` containment to the whole disk.** Rejected: it would
  silently reclassify every agent and plugin read path that shares the
  contained reader, destroying the boundary the security spec promises
  instead of adding a user-scoped exception beside it.
- **A user-approved directory allowlist / sensitive-path deny list.**
  Rejected by the explicit request: no confirmation step, no content or
  path filtering. The boundary is "the user clicked this file", not "this
  file is on a list".
- **Routing outside files through the bundled `pi.file-manager` view.**
  Rejected: that view is project-rooted, may be disabled, and its host-picked
  exception path (ADR 0262 §4) is a plugin trust position this change does
  not need. The host `file:` tab already previews absolute paths and keeps
  the bytes in main.
- **Keeping the restriction and explaining it better.** Rejected: it refuses
  a decision the user already made and pushes the same read into a shell
  next to the app, exactly the failure mode D604 documents for user endpoints.
