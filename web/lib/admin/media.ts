// Media library types and the checks made before an upload is sent. The API
// decides what a file is from its bytes; these only save a pointless upload.

import { z } from "zod";
import { API_ORIGIN } from "@/lib/api-base";

/** The API's own limit for one image (MEDIA_MAX_BYTES). */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export type Variant = { name: string; width: number; height: number; size: number };

export type MediaItem = {
  id: string;
  alt: string;
  width: number;
  height: number;
  size: number;
  created_at: string;
  variants: Variant[];
  preview: string;
};

const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export const mediaAltSchema = z.strictObject({
  alt: z
    .string()
    .trim()
    .min(1, "Describe the image for people who cannot see it.")
    .max(300, "Keep this to 300 characters.")
    .refine((v) => !/[\r\n\u2028\u2029]/.test(v), "Keep this to one line."),
});

/** A message if the file is plainly not acceptable, else null. */
export function checkUpload(file: File): string | null {
  if (file.size > MAX_UPLOAD_BYTES) return "Use an image under 8 MB.";
  if (!TYPES.has(file.type)) return "Choose a JPEG, PNG or WebP image.";
  return null;
}

/** Where the admin shows a preview of a media item, published or not. */
export function previewUrl(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Not a media id.");
  return `${API_ORIGIN}/api/v1/admin/media/${id}/file`;
}
