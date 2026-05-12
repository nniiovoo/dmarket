"use client";

import { useRef, useState } from "react";

import { uploadSellerImage } from "@/lib/api/seller";

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const maxBytes = 4 * 1024 * 1024;

export function ImageUpload({
  value,
  onChange,
  fallbackToUrl = true
}: {
  value: string;
  onChange: (url: string) => void;
  fallbackToUrl?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [showUrlInput, setShowUrlInput] = useState(fallbackToUrl && value.length > 0);

  async function upload(file: File | undefined) {
    if (!file) {
      return;
    }

    const validation = validateFile(file);

    if (validation) {
      setError(validation);
      setShowUrlInput(fallbackToUrl);
      return;
    }

    setUploading(true);
    setError(undefined);

    try {
      const result = await uploadSellerImage(file);
      onChange(result.url);
      setShowUrlInput(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Image upload failed");
      setShowUrlInput(fallbackToUrl);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-3">
      {value ? (
        <div className="flex flex-col gap-3 rounded-md border border-slate-200 p-3 sm:flex-row sm:items-center">
          <div
            aria-label="Selected product image"
            className="h-24 w-24 rounded-md bg-slate-100 bg-cover bg-center"
            role="img"
            style={{ backgroundImage: `url("${value}")` }}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-950">{value}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700"
              >
                Re-upload
              </button>
              <button
                type="button"
                onClick={() => onChange("")}
                className="rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void upload(event.dataTransfer.files[0]);
          }}
          className="flex min-h-36 w-full flex-col items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center hover:bg-slate-100"
        >
          <span className="text-sm font-medium text-slate-800">Drag an image here or click to choose</span>
          <span className="mt-1 text-xs text-slate-500">JPEG, PNG, WebP, or GIF up to 4 MB</span>
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={(event) => {
          void upload(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
      />

      {uploading ? (
        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full w-2/3 animate-pulse rounded-full bg-slate-900" />
        </div>
      ) : null}

      {error ? <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">{error}</p> : null}

      {fallbackToUrl && (showUrlInput || error) ? (
        <label className="block">
          <span className="text-sm font-medium text-slate-700">External image URL</span>
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="https://..."
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 outline-none"
          />
          <span className="mt-1 block text-xs text-slate-500">
            Upload to imgur, postimages, GitHub, or another image host, then paste the direct image URL.
          </span>
        </label>
      ) : fallbackToUrl ? (
        <button type="button" onClick={() => setShowUrlInput(true)} className="text-sm font-medium text-blue-700 underline">
          Paste an external URL instead
        </button>
      ) : null}
    </div>
  );
}

function validateFile(file: File) {
  if (!allowedTypes.has(file.type)) {
    return "Use a JPEG, PNG, WebP, or GIF image.";
  }

  if (file.size > maxBytes) {
    return "Image must be 4 MB or smaller.";
  }

  return undefined;
}
