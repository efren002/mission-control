"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";

import { catalogApi, type ObjectiveAttachment } from "@/features/catalog/api";

export const MAX_MISSION_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function acceptMissionImages(
  incoming: File[],
  existingCount: number,
): { accepted: File[]; rejected: string[] } {
  const accepted: File[] = [];
  const rejected: string[] = [];
  for (const file of incoming) {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      rejected.push(`${file.name || "file"}: only PNG, JPEG, WebP, or GIF images are supported`);
    } else if (file.size > MAX_IMAGE_BYTES) {
      rejected.push(`${file.name || "image"}: images must be 5 MB or smaller`);
    } else if (existingCount + accepted.length >= MAX_MISSION_IMAGES) {
      rejected.push(`${file.name || "image"}: a mission can have at most ${MAX_MISSION_IMAGES} images`);
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejected };
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function filesFromClipboard(event: React.ClipboardEvent): File[] {
  return Array.from(event.clipboardData?.files ?? []).filter((file) =>
    file.type.startsWith("image/"),
  );
}

export function filesFromDrop(event: React.DragEvent): File[] {
  return Array.from(event.dataTransfer?.files ?? []).filter((file) =>
    file.type.startsWith("image/"),
  );
}

/** Shared drag-over/drop wiring so any container can accept dropped images. */
function useImageDropZone(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  return {
    dragging,
    zoneProps: {
      onDragOver: (event: React.DragEvent) => {
        if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      },
      onDragLeave: (event: React.DragEvent) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      },
      onDrop: (event: React.DragEvent) => {
        setDragging(false);
        const dropped = filesFromDrop(event);
        if (dropped.length === 0) return;
        event.preventDefault();
        onFiles(dropped);
      },
    },
  };
}

// jsdom has no object URL support, so previews degrade to placeholders there.
const canPreview = typeof URL !== "undefined" && typeof URL.createObjectURL === "function";

/** Image picker for a mission that does not exist yet: keeps files in memory. */
export function MissionImagePicker({
  files,
  onChange,
  disabled,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [warning, setWarning] = useState("");

  const add = (incoming: File[]) => {
    const { accepted, rejected } = acceptMissionImages(incoming, files.length);
    if (accepted.length > 0) onChange([...files, ...accepted]);
    setWarning(rejected.join(" "));
  };
  const { dragging, zoneProps } = useImageDropZone(add);

  return (
    <div
      {...zoneProps}
      className={dragging ? "border border-dashed border-signal/60 bg-signal/[0.04] p-2" : ""}
      onPaste={(event) => {
        const pasted = filesFromClipboard(event);
        if (pasted.length > 0) {
          event.preventDefault();
          add(pasted);
        }
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(",")}
        multiple
        className="hidden"
        onChange={(event) => {
          add(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={disabled || files.length >= MAX_MISSION_IMAGES}
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-2 border border-[#292824] px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-dim hover:border-[#55524c] hover:text-terminal disabled:opacity-40"
        >
          <ImagePlus className="h-3 w-3" /> Attach images
        </button>
        <span className="text-[10px] text-dim">
          Optional. Add error screenshots or UI references. You can also paste from the
          clipboard or drop image files here.
        </span>
      </div>
      {warning && <p className="mt-2 text-[10px] text-orange-300">{warning}</p>}
      {files.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3">
          {files.map((file, index) => (
            <PendingImagePreview
              key={`${file.name}-${index}`}
              file={file}
              onRemove={() => onChange(files.filter((_, at) => at !== index))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PendingImagePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (!canPreview) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return (
    <figure className="relative w-24">
      {url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={file.name}
          className="h-16 w-24 border border-[#292824] object-cover"
        />
      )}
      <button
        type="button"
        onClick={onRemove}
        title={`Remove ${file.name}`}
        className="absolute right-1 top-1 border border-[#292824] bg-black/80 p-0.5 text-dim hover:text-orange-300"
      >
        <X className="h-3 w-3" />
      </button>
      <figcaption className="mt-1 truncate text-[9px] text-dim" title={file.name}>
        {file.name}
      </figcaption>
    </figure>
  );
}

/** Attachments of an existing mission: lists, previews, uploads, and deletes. */
export function MissionAttachments({
  token,
  objectiveId,
}: {
  token: string;
  objectiveId: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<ObjectiveAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setAttachments(await catalogApi.attachments(token, objectiveId));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load mission images");
    }
  }, [token, objectiveId]);

  useEffect(() => {
    setAttachments([]);
    void load();
  }, [load]);

  const upload = async (incoming: File[]) => {
    const { accepted, rejected } = acceptMissionImages(incoming, attachments.length);
    setError(rejected.join(" "));
    if (accepted.length === 0) return;
    setBusy(true);
    try {
      for (const file of accepted) {
        await catalogApi.uploadAttachment(token, objectiveId, file);
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to upload the image");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (attachment: ObjectiveAttachment) => {
    setBusy(true);
    try {
      await catalogApi.deleteAttachment(token, objectiveId, attachment.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to remove the image");
    } finally {
      setBusy(false);
    }
  };

  const { dragging, zoneProps } = useImageDropZone((dropped) => void upload(dropped));

  return (
    <section
      {...zoneProps}
      className={`mt-6 ${
        dragging ? "border border-dashed border-signal/60 bg-signal/[0.04] p-2" : ""
      }`}
      onPaste={(event) => {
        const pasted = filesFromClipboard(event);
        if (pasted.length > 0) {
          event.preventDefault();
          void upload(pasted);
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-[10px] font-bold uppercase tracking-wider text-signal">
          Images ({attachments.length}/{MAX_MISSION_IMAGES})
        </h3>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_IMAGE_TYPES.join(",")}
          multiple
          className="hidden"
          onChange={(event) => {
            void upload(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={busy || attachments.length >= MAX_MISSION_IMAGES}
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-dim hover:text-terminal disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ImagePlus className="h-3 w-3" />}
          Add image
        </button>
      </div>
      <p className="mt-1 text-[10px] text-dim">
        The agents open these images while planning and building. Paste a screenshot, drop
        image files here, or add them with the button.
      </p>
      {error && <p className="mt-2 text-[10px] text-orange-300">{error}</p>}
      {attachments.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3">
          {attachments.map((attachment) => (
            <AttachmentPreview
              key={attachment.id}
              token={token}
              attachment={attachment}
              disabled={busy}
              onRemove={() => void remove(attachment)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AttachmentPreview({
  token,
  attachment,
  disabled,
  onRemove,
}: {
  token: string;
  attachment: ObjectiveAttachment;
  disabled: boolean;
  onRemove: () => void;
}) {
  const [url, setUrl] = useState("");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!canPreview) return;
    let objectUrl = "";
    let cancelled = false;
    void catalogApi
      .attachmentContent(token, attachment.objective_id, attachment.id)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) URL.revokeObjectURL(objectUrl);
        else setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [token, attachment.objective_id, attachment.id]);

  return (
    <figure className="relative w-24">
      {url ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          title={`View ${attachment.filename}`}
          className="block"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={attachment.filename}
            className="h-16 w-24 border border-[#292824] object-cover"
          />
        </button>
      ) : (
        <div className="grid h-16 w-24 place-items-center border border-[#292824]">
          <Loader2 className="h-3 w-3 animate-spin text-dim" />
        </div>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        title={`Remove ${attachment.filename}`}
        className="absolute right-1 top-1 border border-[#292824] bg-black/80 p-0.5 text-dim hover:text-orange-300 disabled:opacity-40"
      >
        <X className="h-3 w-3" />
      </button>
      <figcaption
        className="mt-1 truncate text-[9px] text-dim"
        title={`${attachment.filename} (${formatSize(attachment.size_bytes)})`}
      >
        {attachment.filename}
      </figcaption>
      {expanded && url && (
        <div
          role="dialog"
          aria-label={attachment.filename}
          onClick={() => setExpanded(false)}
          className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={attachment.filename}
            className="max-h-full max-w-full border border-[#55524c] object-contain"
          />
        </div>
      )}
    </figure>
  );
}
