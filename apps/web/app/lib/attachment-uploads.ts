// Upload state machine for the composer's attachment tray.
//
// Lifecycle per file:
//   1. local "queued" slot is added to component state
//   2. attachment:upload-init       → presigned PUT URL
//   3. PUT bytes to S3 (browser → MinIO/S3 directly)
//   4. attachment:upload-finalise   → record metadata row
//   5. on send, mail:send / mail:reply carries `{ fileId }` references
//   6. attachment:remove            → delete (server cascade-removes
//      the staging row + best-effort S3 cleanup)
//
// Mirrors collaboration-ai's flow byte-for-byte so we get the same
// "no large bodies through the API" guarantee.

import { useCallback, useMemo, useRef, useState } from "react";
import { dispatchCommand } from "./commands-client";

export type AttachmentSlotStatus = "queued" | "uploading" | "ready" | "failed";

export interface AttachmentSlot {
  readonly id: string;
  readonly fileId: string | null;
  readonly filename: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly status: AttachmentSlotStatus;
  readonly error?: string;
}

interface InitResult {
  fileId: string;
  objectKey: string;
  putUrl: string;
  headers: Record<string, string>;
}

interface UploadHookOptions {
  readonly draftId?: string | null;
  readonly maxBytes?: number;
}

// 25 MB matches the conservative Gmail attachment limit; users will
// see a friendly error rather than the API rejecting a 35 MB MIME
// envelope after upload.
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export function useAttachmentUploads(opts: UploadHookOptions = {}) {
  const [slots, setSlots] = useState<AttachmentSlot[]>([]);
  const slotsRef = useRef<AttachmentSlot[]>([]);
  slotsRef.current = slots;

  const updateSlot = useCallback(
    (slotId: string, patch: Partial<AttachmentSlot>) => {
      setSlots((prev) =>
        prev.map((s) => (s.id === slotId ? { ...s, ...patch } : s)),
      );
    },
    [],
  );

  const addFiles = useCallback(
    async (files: readonly File[]) => {
      const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
      for (const file of files) {
        if (file.size > max) {
          // Surface as a failed slot so the tray shows the user why.
          const id = `slot_${Math.random().toString(36).slice(2)}`;
          setSlots((prev) => [
            ...prev,
            {
              id,
              fileId: null,
              filename: file.name,
              mime: file.type || "application/octet-stream",
              sizeBytes: file.size,
              status: "failed",
              error: "too-large",
            },
          ]);
          continue;
        }
        const slot: AttachmentSlot = {
          id: `slot_${Math.random().toString(36).slice(2)}`,
          fileId: null,
          filename: file.name,
          mime: file.type || "application/octet-stream",
          sizeBytes: file.size,
          status: "uploading",
        };
        setSlots((prev) => [...prev, slot]);
        void runUpload(slot, file, opts.draftId ?? null, updateSlot);
      }
    },
    [opts.draftId, opts.maxBytes, updateSlot],
  );

  const remove = useCallback((slotId: string) => {
    const slot = slotsRef.current.find((s) => s.id === slotId);
    setSlots((prev) => prev.filter((s) => s.id !== slotId));
    if (slot?.fileId) {
      void dispatchCommand({
        type: "attachment:remove",
        payload: { fileId: slot.fileId },
      }).catch(() => undefined);
    }
  }, []);

  const reset = useCallback(() => {
    // Best-effort cleanup of staged uploads; server janitor catches
    // anything we miss.
    for (const s of slotsRef.current) {
      if (s.fileId) {
        void dispatchCommand({
          type: "attachment:remove",
          payload: { fileId: s.fileId },
        }).catch(() => undefined);
      }
    }
    setSlots([]);
  }, []);

  // What the send command needs.
  const refs = useMemo(
    () =>
      slots
        .filter((s): s is AttachmentSlot & { fileId: string } => !!s.fileId && s.status === "ready")
        .map((s) => ({ fileId: s.fileId })),
    [slots],
  );

  return { slots, addFiles, remove, reset, refs };
}

async function runUpload(
  slot: AttachmentSlot,
  file: File,
  draftId: string | null,
  updateSlot: (slotId: string, patch: Partial<AttachmentSlot>) => void,
): Promise<void> {
  try {
    const initRes = await dispatchCommand({
      type: "attachment:upload-init",
      payload: {
        filename: file.name,
        mime: file.type || "application/octet-stream",
        sizeBytes: file.size,
        ...(draftId ? { draftId } : {}),
      },
    });
    const init = readInitData(initRes);
    if (!init) throw new Error("init: missing presigned URL");

    const putRes = await fetch(init.putUrl, {
      method: "PUT",
      headers: init.headers,
      body: file,
    });
    if (!putRes.ok) {
      throw new Error(`PUT failed: ${putRes.status}`);
    }

    await dispatchCommand({
      type: "attachment:upload-finalise",
      payload: {
        fileId: init.fileId,
        objectKey: init.objectKey,
        filename: file.name,
        mime: file.type || "application/octet-stream",
        sizeBytes: file.size,
        ...(draftId ? { draftId } : {}),
      },
    });

    updateSlot(slot.id, { fileId: init.fileId, status: "ready" });
  } catch (err) {
    updateSlot(slot.id, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function readInitData(mutation: { after: readonly { kind: string; data: Record<string, unknown> }[] }): InitResult | null {
  const after = mutation.after.find((s) => s.kind === "attachment");
  if (!after) return null;
  const d = after.data;
  if (
    typeof d["fileId"] === "string" &&
    typeof d["objectKey"] === "string" &&
    typeof d["putUrl"] === "string"
  ) {
    return {
      fileId: d["fileId"] as string,
      objectKey: d["objectKey"] as string,
      putUrl: d["putUrl"] as string,
      headers: (d["headers"] as Record<string, string>) ?? {},
    };
  }
  return null;
}
