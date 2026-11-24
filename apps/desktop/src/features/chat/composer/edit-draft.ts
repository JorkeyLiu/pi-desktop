import {
  formatPromptPathText,
  formatSessionLink,
  inlinePlacementMarker,
  isRenderableAttachment,
  type MessageAttachment,
} from "@pi-desktop/shared";
import { allocateChipTokens } from "./clipboard";
import { createFileReference } from "./editor";
import type { ComposerFileReference } from "./model";

/**
 * The inline edit draft: one chip token per attachment of an existing user
 * message, so the message editor renders the same atomic `@name` chips as the
 * main composer instead of a second plain-text pipeline.
 *
 * A chip that still names its stored marker round-trips back to that exact
 * text; a chip the user deletes removes its attachment from the resend. Newly
 * staged files become `@path` markers with the recorded placement the send
 * path already understands.
 */
export type EditDraftReference = ComposerFileReference & {
  /**
   * The stored text this chip stands for: the recorded `inlinePath` when the
   * message placed it, otherwise the `@path` its own ref serializes to.
   */
  marker: string;
  /** True when the marker was found in the stored content; false when appended. */
  placed: boolean;
  /** True for files staged during this edit; no durable row stands behind them. */
  staged?: boolean;
  /**
   * The durable attachment this chip was hydrated from, so the resend keeps
   * its recorded placement, MIME type, and size instead of re-deriving them.
   */
  source?: MessageAttachment;
};

export type HydratedEditDraft = {
  text: string;
  references: EditDraftReference[];
  /** Attachments the chip model never owns (e.g. session refs); resend keeps them. */
  carried: MessageAttachment[];
};

const editableAttachment = (
  attachment: MessageAttachment,
): attachment is MessageAttachment & { kind: "image" | "file" } =>
  isRenderableAttachment(attachment) && typeof attachment.ref === "string";

function markerFor(attachment: MessageAttachment): string {
  return (
    inlinePlacementMarker(attachment.inlinePath) ??
    formatPromptPathText(attachment.ref)
  );
}

/**
  * The editable seed for an existing message: the baseline slash contract.
  * When the message carries its original typed invocation (`command`), the
  * draft seeds that invocation alone so retrying re-expands the template
  * (D123); otherwise the stored content seeds the draft. Non-command
  * messages keep their canonical full content via the full-history hydrate —
  * never clipped display text.
  */
export function editSeedContent(
  command: string | undefined,
  content: string,
): string {
  return command || content;
}

/**
 * Rebuild an existing message as an inline chip draft: every placed marker
 * becomes one sentinel at its stored position, and every attachment the body
 * does not name is appended as an explicit removable chip after the text.
 */
export function hydrateUserMessageEdit(
  content: string,
  attachments: readonly MessageAttachment[] | undefined,
  sessionId: string,
): HydratedEditDraft {
  const carried = (attachments ?? []).filter(
    (attachment) => !editableAttachment(attachment),
  );
  const editable = (attachments ?? []).filter(editableAttachment);
  const tokens = allocateChipTokens(editable.length, content, []);
  let text = content;
  let cursor = 0;
  const references: EditDraftReference[] = [];
  editable.forEach((attachment, index) => {
    const token = tokens[index];
    if (!token) throw new Error("message edit ran out of chip tokens");
    const marker = markerFor(attachment);
    const found = marker ? text.indexOf(marker, cursor) : -1;
    if (found !== -1) {
      text = text.slice(0, found) + token + text.slice(found + marker.length);
      cursor = found + token.length;
      references.push({
        ...createFileReference(attachment.ref, attachment.name, sessionId, {
          kind: attachment.kind,
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          token,
        }),
        marker,
        placed: true,
        source: attachment,
      });
      return;
    }
    if (text && !/\s$/.test(text)) text += " ";
    text += token;
    references.push({
      ...createFileReference(attachment.ref, attachment.name, sessionId, {
        kind: attachment.kind,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        token,
      }),
      marker,
      placed: false,
      source: attachment,
    });
    cursor = text.length;
  });
  return { text, references, carried };
}

/** Tag freshly staged chips so serialization can tell them from durable rows. */
export function tagStagedEditReferences(
  references: readonly EditDraftReference[],
  stagedCount: number,
): void {
  for (
    let index = references.length - stagedCount;
    index < references.length;
    index += 1
  ) {
    const reference = references[index];
    if (!reference) continue;
    reference.staged = true;
    reference.marker =
      reference.kind === "session"
        ? formatSessionLink(reference.path)
        : formatPromptPathText(reference.path);
  }
}

export type SerializedEditDraft = {
  content: string;
  attachments: MessageAttachment[];
};

/**
 * Serialize the chip draft back to the existing retry interface: placed chips
 * restore their stored markers in place, kept trailing chips stay trailing
 * attachments without inventing path text, staged chips become `@path`
 * markers with their recorded placement, and deleted chips drop out.
 */
export function serializeUserMessageEdit(
  text: string,
  references: readonly EditDraftReference[],
  carried: readonly MessageAttachment[],
): SerializedEditDraft {
  let content = text;
  const kept: MessageAttachment[] = [...carried];
  for (const reference of references) {
    const token = reference.token;
    if (!token || !content.includes(token)) continue;
    if (reference.staged) {
      content = content.split(token).join(reference.marker);
      kept.push(
        reference.kind === "session"
          ? { ref: reference.path, name: reference.name, kind: "session" as const }
          : {
              ref: reference.path,
              name: reference.name,
              kind: reference.kind as "image" | "file",
              ...(reference.mimeType ? { mimeType: reference.mimeType } : {}),
              inlinePath: reference.marker,
            },
      );
      continue;
    }
    if (reference.placed) {
      content = content.split(token).join(reference.marker);
      kept.push(durableEditAttachment(reference));
      continue;
    }
    content = content.split(token).join("");
    kept.push(durableEditAttachment(reference));
  }
  return { content: content.trim(), attachments: kept };
}

/** The durable row's own attachment, unchanged except for surviving the edit. */
function durableEditAttachment(reference: EditDraftReference): MessageAttachment {
  if (reference.source) return { ...reference.source };
  const attachment: MessageAttachment = {
    ref: reference.path,
    name: reference.name,
    kind: reference.kind as "image" | "file",
  };
  return attachment;
}
