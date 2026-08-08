#!/usr/bin/env node
/**
 * Smoke test: prove a headless summon runs through the built CLI.
 *
 * Spawns `node dist/cli.js` with a trivial prompt, asserts stdout is one JSON
 * envelope with an `output` field, and prints PASS/FAIL.
 *
 * Provider credentials come from the ambient environment (the same way the
 * CLI resolves them). When no provider is configured the summon is a usage
 * error (exit 2) and the smoke SKIPs with a clear message instead of failing.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "dist", "cli.js");
const PROMPT = 'Reply with exactly: {"ok":true}';

/**
 * Probe whether any known provider endpoint is reachable. The CLI resolves
 * providers from ambient env; when credentials exist but the network is
 * unreachable (offline sandbox, DNS blocked), the summon fails in flight and
 * the smoke should SKIP rather than FAIL.
 */
function providerReachable(timeoutMs = 3000) {
  const hosts = ["api.anthropic.com", "api.openai.com", "openrouter.ai"];
  return Promise.race([
    (async () => {
      for (const host of hosts) {
        try {
          await new Promise((resolve, reject) => {
            const socket = connect({ host, port: 443, timeout: timeoutMs });
            socket.once("connect", () => {
              socket.destroy();
              resolve();
            });
            socket.once("error", reject);
            socket.once("timeout", () => {
              socket.destroy();
              reject(new Error("timeout"));
            });
          });
          return true;
        } catch {
          // try next host
        }
      }
      return false;
    })(),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs + 500)),
  ]);
}

function run(args, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
    child.stdin.end(input ?? "");
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const args = argv.length > 0 ? argv : [PROMPT];

  const result = await run(args, args.length > 1 ? undefined : "");
  const { code, stdout, stderr } = result;

  if (code !== 0 && !(await providerReachable())) {
    console.log(
      "SKIP: no provider endpoint reachable from this environment " +
        "(credentials may be set, but network egress to api.anthropic.com / " +
        "api.openai.com / openrouter.ai is blocked).",
    );
    process.exit(0);
  }

  const noCredentials = code === 2 && /no configured provider/.test(stderr);
  const noReachability =
    code === 1 &&
    /connection error|fetch failed|getaddrinfo|ECONNREFUSED|ENOTFOUND|network/i.test(
      stderr,
    );
  if (noCredentials || noReachability) {
    console.log(
      "SKIP: no provider reachable in this environment " +
        "(set e.g. ANTHROPIC_API_KEY, OPENROUTER_API_KEY and ensure " +
        "network egress to the provider).",
    );
    process.exit(0);
  }

  if (code !== 0) {
    console.error(`FAIL: cli exited ${code}`);
    if (stderr) console.error(stderr.trim());
    process.exit(1);
  }

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (error) {
    console.error(`FAIL: stdout is not a JSON envelope: ${error.message}`);
    console.error(`stdout: ${stdout.slice(0, 500)}`);
    process.exit(1);
  }

  if (typeof envelope.output !== "string") {
    console.error("FAIL: envelope.output is not a string");
    console.error(`stdout: ${stdout}`);
    process.exit(1);
  }

  console.log(`PASS: summon completed (${envelope.model ?? "unknown model"}).`);
}

main().catch((error) => {
  console.error(`FAIL: smoke crashed: ${error.message}`);
  process.exit(1);
});
