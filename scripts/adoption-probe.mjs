#!/usr/bin/env node
/**
 * Read-only probe for the miniharness JSONL session directory.
 *
 * Mirrors heatmap's adoption join (`heatmap/src/recap/adopt.rs`): walk the
 * session files, find the prompt line, extract the staged-transcript key of
 * the form `<work>/session/<64-hex>/transcript.txt`, and collect the
 * assistant text. One JSON object is printed per session:
 *
 *   { file, session_id, stage_key, prompt_chars, assistant_chars }
 *
 * This is a script, not shipped CLI surface: it proves the files miniharness
 * writes carry the data heatmap's adopt join reads back. Exit codes are
 * script-local (0 read, 1 unusable input); they are NOT the DEC summon codes.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const STAGE_KEY_LEN = 64;
const STAGE_FILE = "/transcript.txt";
const HEX = /^[0-9a-fA-F]{64}$/;

/**
 * Extract the staged transcript key a prompt names. The prompt tells the
 * harness to read `<work>/session/<key>/transcript.txt`; that `<key>` is what
 * ties the summon back to a heatmap session. Mirrors adopt.rs `stage_key`.
 */
export function stageKey(prompt) {
  const idx = prompt.indexOf(STAGE_FILE);
  if (idx === -1) return null;
  const key = prompt.slice(0, idx).split("/").at(-1) ?? "";
  return HEX.test(key) ? key : null;
}

/** Collect assistant text parts from a parsed JSONL session, in order. */
function assistantParts(parsed) {
  const parts = [];
  for (const line of parsed) {
    if (line.kind !== "entry" || line.entry?.type !== "message") continue;
    const message = line.entry.message;
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") {
      const text = message.content.trim();
      if (text.length > 0) parts.push(text);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
        parts.push(block.text.trim());
      }
    }
  }
  return parts;
}

/** Parse a JSONL file into lines; throws with a useful message on bad input. */
export function parseJsonl(path) {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new Error(`${path}: file is empty`);
  const parsed = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === "") continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`${path}:${index + 1}: not valid JSON: ${error.message}`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path}:${index + 1}: line is not a JSON object`);
    }
    parsed.push(value);
  }
  return parsed;
}

/** Default session directory: $MINIHARNESS_SESSION_DIR, else the DEC default. */
export function defaultSessionDir() {
  if (process.env.MINIHARNESS_SESSION_DIR) return process.env.MINIHARNESS_SESSION_DIR;
  return join(homedir(), ".local", "share", "miniharness", "sessions");
}

/** Session id from the file name: `<timestamp>_<id>.jsonl` -> `<id>`. */
function sessionIdFromFile(name) {
  const stem = name.replace(/\.jsonl$/, "");
  const at = stem.indexOf("_");
  return at === -1 ? stem : stem.slice(at + 1);
}

/** Probe one session file; returns the report object (or null when the file
 *  has no recognizable prompt). */
function probeFile(file) {
  const parsed = parseJsonl(file);
  const sessionId = sessionIdFromFile(basename(file));
  let prompt = null;
  for (const line of parsed) {
    if (line.kind !== "entry" || line.entry?.type !== "message") continue;
    const message = line.entry.message;
    if (message?.role !== "user") continue;
    const text = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((block) => block?.type === "text" && typeof block.text === "string" ? block.text : "").join("")
        : "";
    prompt = text;
    break;
  }
  if (prompt === null) return null;
  const parts = assistantParts(parsed);
  return {
    file,
    session_id: sessionId,
    stage_key: stageKey(prompt),
    prompt_chars: prompt.length,
    assistant_chars: parts.join("\n").length,
  };
}

/** Walk a session dir and probe every `.jsonl` file. */
export function probeSessionDir(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot read session dir ${dir}: ${error.message}`);
  }
  const reports = [];
  for (const entry of entries) {
    if (entry.isDirectory() || !entry.name.endsWith(".jsonl")) continue;
    const file = join(dir, entry.name);
    const report = probeFile(file);
    if (report !== null) reports.push(report);
  }
  reports.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return reports;
}

function main() {
  const dir = process.argv[2] ?? defaultSessionDir();
  try {
    const reports = probeSessionDir(dir);
    for (const report of reports) process.stdout.write(JSON.stringify(report) + "\n");
  } catch (error) {
    process.stderr.write(`adoption-probe: ${error.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
