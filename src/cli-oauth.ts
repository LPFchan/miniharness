/**
 * DEC-20260808-002 — reuse the operator's existing Claude Code and Codex
 * CLI OAuth logins as summon credentials.
 *
 * The first-party CLIs already maintain subscription OAuth tokens on disk:
 *
 * - Claude Code: `~/.claude/.credentials.json`
 *   (`claudeAiOauth.{accessToken, refreshToken, expiresAt}`)
 * - Codex CLI: `~/.codex/auth.json`
 *   (`tokens.{access_token, refresh_token, account_id}`)
 *
 * Both shapes are a field rename of pi-ai's OAuth credential
 * (`{ type: "oauth", access, refresh, expires }`), and pi-ai refreshes
 * against the same public OAuth client IDs the CLIs use. This module
 * implements pi-ai's `CredentialStore` contract over those files:
 * `read` translates the CLI shape; `modify` (the only write path, invoked
 * by pi-ai's refresh-under-lock flow) writes rotated tokens back to the
 * CLI file so miniharness and the CLIs share one token lineage instead of
 * double-refreshing each other into invalidation.
 *
 * Failure semantics (per the DEC): reading is defensive — a missing file,
 * malformed JSON, or missing token fields resolves as "no credential" and
 * the provider surfaces its ordinary auth error. Write-back is atomic
 * (temp file + rename) and best-effort — a failed write degrades the next
 * refresh, never the in-flight summon.
 *
 * Env overrides for tests and non-standard homes:
 * `MINIHARNESS_CLAUDE_CREDENTIALS_FILE`, `MINIHARNESS_CODEX_AUTH_FILE`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from "@earendil-works/pi-ai";

/** Claude Code credentials file (env override for tests). */
export function claudeCredentialsFile(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.MINIHARNESS_CLAUDE_CREDENTIALS_FILE ??
    join(homedir(), ".claude", ".credentials.json")
  );
}

/** Codex CLI auth file (env override for tests). */
export function codexAuthFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINIHARNESS_CODEX_AUTH_FILE ?? join(homedir(), ".codex", "auth.json");
}

/**
 * OAuth credential minus the `type` tag (the extractors' return shape).
 * Declared field-by-field because `OAuthCredentials` carries an index
 * signature, which collapses under `Omit`.
 */
interface OAuthCredentialData {
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
}

/** CLI-file readers keyed by pi provider id. */
interface CliCredentialSource {
  file: () => string;
  /** Translate the CLI file's parsed JSON into a pi-ai OAuth credential. */
  extract: (parsed: Record<string, unknown>) => OAuthCredentialData | undefined;
  /** Merge rotated tokens back into the CLI file's parsed JSON. */
  merge: (parsed: Record<string, unknown>, credential: OAuthCredential) => Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * CLI-file readers keyed by the provider id pi-ai passes to the store —
 * which is `provider.id`, and under DEC-20260808-002 that is the registry
 * name (`anthropic`, `codex`), since the summon-path aliases re-id the
 * builtins for routing.
 */
const SOURCES: Record<string, CliCredentialSource> = {
  anthropic: {
    file: () => claudeCredentialsFile(),
    extract: (parsed) => {
      const oauth = record(parsed.claudeAiOauth);
      if (!oauth) return undefined;
      const access = str(oauth.accessToken);
      const refresh = str(oauth.refreshToken);
      const expires = num(oauth.expiresAt);
      if (!access || !refresh || expires === undefined) return undefined;
      return { access, refresh, expires };
    },
    merge: (parsed, credential) => {
      const oauth = record(parsed.claudeAiOauth) ?? {};
      return {
        ...parsed,
        claudeAiOauth: {
          ...oauth,
          accessToken: credential.access,
          refreshToken: credential.refresh,
          expiresAt: credential.expires,
        },
      };
    },
  },
  codex: {
    file: () => codexAuthFile(),
    extract: (parsed) => {
      const tokens = record(parsed.tokens);
      if (!tokens) return undefined;
      const access = str(tokens.access_token);
      const refresh = str(tokens.refresh_token);
      if (!access || !refresh) return undefined;
      // Codex CLI auth.json does not record an expiry; treat the access
      // token as always-refreshable so pi-ai's five-minute window triggers
      // a refresh on first use rather than trusting a stale token.
      const expires = num(tokens.expires_at) ?? 0;
      const accountId = str(tokens.account_id);
      return { access, refresh, expires, ...(accountId ? { accountId } : {}) };
    },
    merge: (parsed, credential) => {
      const tokens = record(parsed.tokens) ?? {};
      const accountId = str(credential.accountId) ?? str(tokens.account_id);
      return {
        ...parsed,
        tokens: {
          ...tokens,
          access_token: credential.access,
          refresh_token: credential.refresh,
          ...(accountId ? { account_id: accountId } : {}),
        },
      };
    },
  },
};

/** Read and parse a CLI credential file; undefined on any failure. */
function readJson(file: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return record(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Atomic write (temp + rename), mode 0600. Throws on failure; callers decide. */
function writeJsonAtomic(file: string, value: Record<string, unknown>): void {
  const tmp = join(dirname(file), `.miniharness-oauth-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * A `CredentialStore` backed by the CLI credential files. One credential
 * per provider id, exactly as pi-ai's contract expects; providers without
 * a CLI source (or without a readable credential) resolve `undefined`.
 *
 * Write-back failures in `modify` are swallowed after the credential is
 * computed: the rotated tokens still serve this process's summon, and the
 * next refresh starts from whatever the file holds.
 */
export class CliOAuthCredentialStore implements CredentialStore {
  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const source = SOURCES[providerId];
    if (!source) return undefined;
    const parsed = readJson(source.file());
    if (!parsed) return undefined;
    const credential = source.extract(parsed);
    if (credential === undefined) return undefined;
    const result: OAuthCredential = { type: "oauth", ...credential };
    return result;
  }

  async list(options?: AuthOperationOptions): Promise<CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const infos: CredentialInfo[] = [];
    for (const providerId of Object.keys(SOURCES)) {
      if ((await this.read(providerId)) !== undefined) {
        infos.push({ providerId, type: "oauth" });
      }
    }
    return infos;
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined> | Credential | undefined,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const current = await this.read(providerId, options);
    const next = await fn(current);
    options?.signal?.throwIfAborted();
    if (next === undefined) return current;
    const source = SOURCES[providerId];
    if (!source || next.type !== "oauth") return next;
    try {
      const file = source.file();
      const parsed = readJson(file) ?? {};
      writeJsonAtomic(file, source.merge(parsed, next));
    } catch {
      // Best-effort write-back: the rotated credential still serves this
      // process; a stale file only means the next refresh starts over.
    }
    return next;
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    // Logout is app-owned and not part of the summon contract; deleting
    // the operator's CLI login from a headless harness is never intended.
    void providerId;
  }
}

/** Directory creation for write-back when the CLI home does not exist yet. */
export function ensureParentDir(file: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    // Write-back will surface its own failure; keep construction total.
  }
}
