import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** A strict, local-only multimodal input manifest (protocol v1). */
export type ManifestPart =
  | { type: "text"; text: string }
  | { type: "image"; path: string; media_type: "image/png" | "image/jpeg"; sha256: string };

export class InputManifestError extends Error {
  override readonly name = "InputManifestError";
}

const ROOT_FIELDS = new Set(["version", "parts"]);
const TEXT_FIELDS = new Set(["type", "text"]);
const IMAGE_FIELDS = new Set(["type", "path", "media_type", "sha256"]);
const MEDIA_TYPES = new Set(["image/png", "image/jpeg"]);
const SHA256 = /^[a-f0-9]{64}$/;

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputManifestError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: Set<string>, context: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new InputManifestError(`${context} contains unknown field "${key}"`);
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InputManifestError(`${name} must be a non-empty string`);
  }
  return value;
}

function readLocalImage(path: string, mediaType: string, expectedHash: string): string {
  if (/^(?:data:|https?:|file:)/i.test(path)) {
    throw new InputManifestError("image path must be a local file, not a URL or data URI");
  }
  if (!isAbsolute(path)) throw new InputManifestError("image path must be absolute");
  let stats;
  try {
    // lstat is intentional: following a symlink would make the manifest's
    // local-file guarantee depend on mutable path indirection.
    stats = lstatSync(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "not found";
    throw new InputManifestError(`cannot read image ${path}: ${detail}`);
  }
  if (stats.isSymbolicLink()) throw new InputManifestError(`image path must not be a symlink: ${path}`);
  if (!stats.isFile()) throw new InputManifestError(`image path is not a regular file: ${path}`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "read failed";
    throw new InputManifestError(`cannot read image ${path}: ${detail}`);
  }
  if (bytes.length === 0) throw new InputManifestError(`image file is empty: ${path}`);
  const isPng = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((mediaType === "image/png" && !isPng) || (mediaType === "image/jpeg" && !isJpeg)) {
    throw new InputManifestError(`image media type does not match file signature: ${path}`);
  }
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expectedHash) {
    throw new InputManifestError(`sha256 mismatch for image ${path}`);
  }
  return bytes.toString("base64");
}

/**
 * Read and validate a manifest before opening a session or constructing a
 * provider. Paths in the manifest are deliberately local and image bytes are
 * converted here so providers receive actual multimodal content.
 */
export function readInputManifest(manifestPath: string): AgentMessage {
  const resolvedManifestPath = resolve(manifestPath);
  let raw: string;
  try {
    raw = readFileSync(resolvedManifestPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "read failed";
    throw new InputManifestError(`cannot read input manifest ${resolvedManifestPath}: ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InputManifestError(`input manifest is not valid JSON: ${resolvedManifestPath}`);
  }
  const root = object(parsed, "input manifest");
  rejectUnknownFields(root, ROOT_FIELDS, "input manifest");
  if (root.version !== 1) throw new InputManifestError("input manifest version must be 1");
  if (!Array.isArray(root.parts) || root.parts.length === 0) {
    throw new InputManifestError("input manifest parts must be a non-empty array");
  }

  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  for (const [index, rawPart] of root.parts.entries()) {
    const part = object(rawPart, `input manifest parts[${index}]`);
    const type = part.type;
    if (type === "text") {
      rejectUnknownFields(part, TEXT_FIELDS, `input manifest parts[${index}]`);
      content.push({ type: "text", text: requiredString(part.text, `input manifest parts[${index}].text`) });
      continue;
    }
    if (type === "image") {
      rejectUnknownFields(part, IMAGE_FIELDS, `input manifest parts[${index}]`);
      const path = requiredString(part.path, `input manifest parts[${index}].path`);
      const mediaType = requiredString(part.media_type, `input manifest parts[${index}].media_type`);
      if (!MEDIA_TYPES.has(mediaType)) {
        throw new InputManifestError(`input manifest parts[${index}].media_type must be image/png or image/jpeg`);
      }
      const hash = requiredString(part.sha256, `input manifest parts[${index}].sha256`);
      if (!SHA256.test(hash)) throw new InputManifestError(`input manifest parts[${index}].sha256 must be lowercase hex`);
      const data = readLocalImage(path, mediaType, hash);
      content.push({ type: "image", data, mimeType: mediaType });
      continue;
    }
    throw new InputManifestError(`input manifest parts[${index}].type must be text or image`);
  }

  return { role: "user", content, timestamp: Date.now() };
}
