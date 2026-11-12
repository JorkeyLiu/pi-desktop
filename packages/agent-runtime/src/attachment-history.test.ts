import { describe, expect, it } from "vitest";
import { hydrateAttachmentHistory } from "./attachment-history.js";
import { MAX_AUTO_PASTED_TEXT_BYTES, type UiMessage } from "@pi-desktop/shared";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import os from "node:os";

async function withTempDir(run: (path: string) => Promise<void>): Promise<void> {
  const path = await mkdtemp(join(os.tmpdir(), "test-attachment-history-"));
  try {
    await run(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

function userMessage(
  id: string,
  attachments: NonNullable<UiMessage["attachments"]>,
): UiMessage {
  return {
    id,
    role: "user",
    content: id,
    createdAt: new Date().toISOString(),
    attachments,
  };
}

describe("hydrateAttachmentHistory", () => {
  it("inlines image attachments within per-image byte limits without consulting capability metadata", async () => {
    await withTempDir(async (tmp) => {
      const imgPath = resolve(tmp, "sample.png");
      await writeFile(imgPath, "fake-png-bytes");
      const history = [
        userMessage("msg-1", [
          {
            name: "sample.png",
            ref: imgPath,
            kind: "image",
            mimeType: "image/png",
            size: 14,
          },
        ]),
      ];

      const hydrated = await hydrateAttachmentHistory(history, {
        projectPath: tmp,
      });

      expect(hydrated[0]?.attachments?.[0]?.data).toBe(
        Buffer.from("fake-png-bytes").toString("base64"),
      );
    });
  });

  it("preserves historical image turns beyond ten messages when within the default byte budget", async () => {
    await withTempDir(async (tmp) => {
      const history: UiMessage[] = [];
      const payloads: string[] = [];
      for (let i = 1; i <= 12; i++) {
        const payload = `image-${i}`;
        const imgPath = resolve(tmp, `sample-${i}.png`);
        await writeFile(imgPath, payload);
        payloads.push(payload);
        history.push(
          userMessage(`msg-${i}`, [
            {
              name: `sample-${i}.png`,
              ref: imgPath,
              kind: "image",
              mimeType: "image/png",
              size: payload.length,
            },
          ]),
        );
      }

      const hydrated = await hydrateAttachmentHistory(history, {
        projectPath: tmp,
      });

      for (let i = 0; i < payloads.length; i++) {
        expect(hydrated[i]?.attachments?.[0]?.data).toBe(
          Buffer.from(payloads[i]!).toString("base64"),
        );
      }
    });
  });

  it("bounds actual aggregate bytes across many attachments in one message", async () => {
    await withTempDir(async (tmp) => {
      const attachments: NonNullable<UiMessage["attachments"]> = [];
      for (let i = 1; i <= 5; i++) {
        const imgPath = resolve(tmp, `burst-${i}.png`);
        await writeFile(imgPath, "x".repeat(100));
        attachments.push({
          name: `burst-${i}.png`,
          ref: imgPath,
          kind: "image",
          mimeType: "image/png",
          // Deliberately incorrect metadata must not bypass the actual byte budget.
          size: 1,
          ...(i === 1 ? { data: "stale-base64-must-be-cleared" } : {}),
        });
      }
      const history = [userMessage("msg-burst", attachments)];

      const hydrated = await hydrateAttachmentHistory(history, {
        projectPath: tmp,
        maxInlinedImageBytes: 250,
      });
      const result = hydrated[0];
      expect(result?.attachments?.map((attachment) => attachment.data)).toEqual([
        undefined,
        undefined,
        undefined,
        Buffer.from("x".repeat(100)).toString("base64"),
        Buffer.from("x".repeat(100)).toString("base64"),
      ]);
      for (let i = 1; i <= 3; i++) {
        expect(result?.content).toContain(`burst-${i}.png`);
        expect(result?.attachments?.[i - 1]?.ref).toContain(`burst-${i}.png`);
      }
    });
  });

  it("treats a zero history byte budget as no images inlined", async () => {
    await withTempDir(async (tmp) => {
      const imgPath = resolve(tmp, "sample.png");
      await writeFile(imgPath, "image");
      const history = [
        userMessage("msg-1", [
          {
            name: "sample.png",
            ref: imgPath,
            kind: "image",
            mimeType: "image/png",
            size: 5,
          },
        ]),
      ];

      const hydrated = await hydrateAttachmentHistory(history, {
        projectPath: tmp,
        maxInlinedImageBytes: 0,
      });

      expect(hydrated[0]?.attachments?.[0]?.data).toBeUndefined();
      expect(hydrated[0]?.content).toContain("sample.png");
    });
  });

  it("restores the text of a long paste the message names as a compact chip", async () => {
    await withTempDir(async (tmp) => {
      const scratchDir = join(tmp, "scratch", "session-1");
      const pastedRoot = join(scratchDir, "pasted", "text");
      const pasted = join(
        pastedRoot,
        "pasted-0f1e2d3c-9f8e-7d6c-b5a4-3210fedcba98-pasted-text-9f8e7d6c.txt",
      );
      const pastedText = "restored pasted body\n中文 🧪 end";
      await mkdir(pastedRoot, { recursive: true });
      await writeFile(pasted, pastedText);
      const history: UiMessage[] = [
        {
          id: "msg-paste",
          role: "user",
          // The persisted row keeps the compact chip text; a paste travels as
          // prompt content, so there is no attachment to hydrate from.
          content: `summarize @${pasted} please`,
          createdAt: new Date().toISOString(),
        },
      ];

      const hydrated = await hydrateAttachmentHistory(history, {
        scratchDir,
      });

      expect(hydrated[0]?.content).toBe(`summarize ${pastedText} please`);
      expect(hydrated[0]?.content).not.toContain(pasted);
    });
  });

  it("leaves a paste-named file the user imported from the picker alone", async () => {
    await withTempDir(async (tmp) => {
      const scratchDir = join(tmp, "scratch", "session-1");
      // A picker or drop import keeps the user's own name one level above the
      // owned auto-text directory, even when that name is a paste name.
      const manual = join(scratchDir, "pasted", "pasted-text-abc.txt");
      await mkdir(join(scratchDir, "pasted"), { recursive: true });
      await writeFile(manual, "manual file the user chose");
      const history: UiMessage[] = [
        {
          id: "msg-manual",
          role: "user",
          content: `read @${manual}`,
          createdAt: new Date().toISOString(),
        },
      ];

      const hydrated = await hydrateAttachmentHistory(history, {
        scratchDir,
      });

      expect(hydrated[0]?.content).toBe(`read @${manual}`);
    });
  });

  it("leaves a same-named file outside the session paste root alone", async () => {
    await withTempDir(async (tmp) => {
      const scratchDir = join(tmp, "scratch", "session-1");
      const projectPath = join(tmp, "project");
      await mkdir(projectPath, { recursive: true });
      const lookalike = join(
        projectPath,
        "pasted-0f1e2d3c-9f8e-7d6c-b5a4-3210fedcba98-pasted-text-9f8e7d6c.txt",
      );
      await writeFile(lookalike, "not the paste");
      const history: UiMessage[] = [
        {
          id: "msg-path",
          role: "user",
          content: `read @${lookalike}`,
          createdAt: new Date().toISOString(),
        },
      ];

      const hydrated = await hydrateAttachmentHistory(history, {
        scratchDir,
        projectPath,
      });

      expect(hydrated[0]?.content).toBe(`read @${lookalike}`);
    });
  });

  it("keeps the compact text when the paste file or its directory is gone", async () => {
    await withTempDir(async (tmp) => {
      const scratchDir = join(tmp, "scratch", "session-1");
      const pastedRoot = join(scratchDir, "pasted", "text");
      const deleted = join(pastedRoot, "pasted-deleted.txt");
      const sweptRoot = join(scratchDir, "other", "pasted", "text");
      const swept = join(sweptRoot, "pasted-swept.txt");
      await mkdir(pastedRoot, { recursive: true });
      const history: UiMessage[] = [
        {
          id: "msg-deleted",
          role: "user",
          content: `summarize @${deleted}`,
          createdAt: new Date().toISOString(),
        },
        {
          id: "msg-swept",
          role: "user",
          content: `summarize @${swept}`,
          createdAt: new Date().toISOString(),
        },
      ];

      // The first message names a file that no longer exists; the second names
      // a directory a scratch sweep already removed. Both keep their compact
      // text so the rest of the transcript still restores.
      const hydrated = await hydrateAttachmentHistory(history, {
        scratchDir,
      });

      expect(hydrated[0]?.content).toBe(`summarize @${deleted}`);
      expect(hydrated[1]?.content).toBe(`summarize @${swept}`);
    });
  });

  it("keeps the compact text for an oversized paste and still inlines images", async () => {
    await withTempDir(async (tmp) => {
      const scratchDir = join(tmp, "scratch", "session-1");
      const pastedRoot = join(scratchDir, "pasted", "text");
      await mkdir(pastedRoot, { recursive: true });
      const oversized = join(pastedRoot, "pasted-huge.txt");
      await writeFile(oversized, "small now");
      await truncate(oversized, MAX_AUTO_PASTED_TEXT_BYTES + 1);
      // A historical image beside it keeps the existing best-effort restore.
      const imagePath = join(scratchDir, "shot.png");
      await writeFile(imagePath, "fake-png-bytes");
      const history: UiMessage[] = [
        {
          id: "msg-mixed",
          role: "user",
          content: `summarize @${oversized}`,
          createdAt: new Date().toISOString(),
          attachments: [
            {
              name: "shot.png",
              ref: imagePath,
              kind: "image",
              mimeType: "image/png",
              size: 14,
            },
          ],
        },
      ];

      const hydrated = await hydrateAttachmentHistory(history, {
        scratchDir,
      });

      expect(hydrated[0]?.content).toBe(`summarize @${oversized}`);
      expect(hydrated[0]?.attachments?.[0]?.data).toBe(
        Buffer.from("fake-png-bytes").toString("base64"),
      );
    });
  });
});
