// secret-drop: secrets enter through a UI dialog and land in a 0600 env file.
// The value NEVER appears in messages, tool results, entries, or notifications —
// only metadata (name, length, time). The model can spend secrets by name
// (secret_exec) but can never read them back.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";

const SECRETS_FILE =
  process.env.PI_SECRETS_FILE ||
  path.join(os.homedir(), ".config", "echolike", "store-secrets.env");
const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const DIALOG_TIMEOUT_MS = 120000;

function load() {
  let raw = "";
  try {
    raw = fs.readFileSync(SECRETS_FILE, "utf8");
  } catch {
    return new Map();
  }
  const m = new Map();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) m.set(t.slice(0, i).trim(), t.slice(i + 1));
  }
  return m;
}

function save(map) {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true, mode: 0o700 });
  const body =
    "# Managed by pi-secret-drop. chmod 600. Never commit, never paste in chat.\n" +
    [...map.entries()].map(([k, v]) => `${k}=${v}`).join("\n") +
    "\n";
  fs.writeFileSync(SECRETS_FILE, body, { mode: 0o600 });
  fs.chmodSync(SECRETS_FILE, 0o600);
}

function checkName(name) {
  if (!NAME_RE.test(name || ""))
    return "Name must match [A-Z][A-Z0-9_]{1,63} (env-var style, e.g. AMO_JWT_SECRET).";
  return null;
}

function scrub(text, value) {
  if (!value) return text;
  return text.split(value).join("***");
}

async function runWithSecret(name, value, command, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: { ...process.env, [name]: value },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    const kill = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", (e) => {
      clearTimeout(kill);
      resolve({ ok: false, out: "", err: String(e?.message || e) });
    });
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve({ ok: code === 0, out: scrub(out, value), err: scrub(err, value) });
    });
  });
}

async function doDrop(name, ui) {
  const bad = checkName(name);
  if (bad) return { ok: false, text: bad };
  const value = await ui.input(`Paste value for ${name} (stored, never shown back):`, "", {
    timeout: DIALOG_TIMEOUT_MS,
  });
  if (value === undefined)
    return { ok: false, text: `Cancelled — nothing stored for ${name}.` };
  if (!value) return { ok: false, text: `Empty — nothing stored for ${name}.` };
  const map = load();
  map.set(name, value);
  save(map);
  try {
    ui.notify(`Stored ${name} (${value.length} chars) in ${SECRETS_FILE}.`, "info");
  } catch {}
  return { ok: true, text: `Stored ${name} (${value.length} chars). Value not shown anywhere.` };
}

function doList() {
  const map = load();
  const names = [...map.keys()];
  return names.length ? `Secrets on file: ${names.join(", ")}` : "No secrets stored.";
}

function doForget(name) {
  const bad = checkName(name);
  if (bad) return { ok: false, text: bad };
  const map = load();
  if (!map.has(name)) return { ok: false, text: `${name} not found.` };
  map.delete(name);
  save(map);
  return { ok: true, text: `Forgot ${name}.` };
}

export default function (pi) {
  const str = () => Type.String();

  pi.registerTool({
    name: "secret_drop",
    label: "Store a secret",
    description:
      "Ask the user for a secret value through a private UI dialog and store it in a 0600 env file under the given NAME. The value is never returned to the transcript — only metadata (stored, length). Use when the user must provide tokens/keys. NAME must be env-var style (e.g. AMO_JWT_SECRET).",
    parameters: Type.Object({ name: str() }),
    exposure: "model-only",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const r = await doDrop(params.name, ctx.ui);
      return { content: [{ type: "text", text: r.text }], details: undefined };
    },
  });

  pi.registerTool({
    name: "secret_list",
    label: "List secret names",
    description: "List stored secret NAMES only (never values).",
    parameters: Type.Object({}),
    exposure: "model-only",
    annotations: { readOnlyHint: true, openWorldHint: false },
    executionMode: "sequential",
    async execute() {
      return { content: [{ type: "text", text: doList() }], details: undefined };
    },
  });

  pi.registerTool({
    name: "secret_forget",
    label: "Delete a secret",
    description: "Delete a stored secret by NAME.",
    parameters: Type.Object({ name: str() }),
    exposure: "model-only",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    executionMode: "sequential",
    async execute(_id, params) {
      const r = doForget(params.name);
      return { content: [{ type: "text", text: r.text }], details: undefined };
    },
  });

  pi.registerTool({
    name: "secret_exec",
    label: "Run with a secret",
    description:
      "Run a command (argv array, no shell) with the named secret injected as an environment variable. Stdout/stderr come back with the value scrubbed. Use to spend secrets (e.g. publish scripts) without ever seeing them.",
    parameters: Type.Object({ name: str(), command: Type.Array(str()), cwd: Type.Optional(str()) }),
    exposure: "model-only",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const bad = checkName(params.name);
      if (bad) return { content: [{ type: "text", text: bad }], details: undefined };
      if (!Array.isArray(params.command) || !params.command.length)
        return { content: [{ type: "text", text: "command must be a non-empty argv array." }], details: undefined };
      const value = load().get(params.name);
      if (value === undefined) {
        const retry = await ctx.ui.confirm(
          "Missing secret",
          `${params.name} is not stored. Store it now?`,
        );
        if (!retry) return { content: [{ type: "text", text: `${params.name} not stored.` }], details: undefined };
        const r = await doDrop(params.name, ctx.ui);
        if (!r.ok) return { content: [{ type: "text", text: r.text }], details: undefined };
        return {
          content: [{ type: "text", text: `${r.text} Re-run secret_exec to use it.` }],
          details: undefined,
        };
      }
      const cwd = params.cwd || ctx.cwd;
      const r = await runWithSecret(params.name, value, params.command, cwd);
      const out = (r.out + (r.err ? `\n[stderr]\n${r.err}` : "")).slice(-4000);
      return { content: [{ type: "text", text: `exit ok=${r.ok}\n${out}` }], details: undefined };
    },
  });

  pi.registerCommand("secret-drop", {
    description: "Store a secret via private dialog (never shown in chat)",
    handler: async (args, ctx) => {
      const r = await doDrop(args.trim().split(/\s+/)[0] || "", ctx.ui);
      ctx.ui.notify(r.text, r.ok ? "info" : "warning");
    },
  });
  pi.registerCommand("secret-list", {
    description: "List stored secret names (never values)",
    handler: async (_args, ctx) => ctx.ui.notify(doList(), "info"),
  });
  pi.registerCommand("secret-forget", {
    description: "Delete a stored secret by name",
    handler: async (args, ctx) => {
      const r = doForget(args.trim().split(/\s+/)[0] || "");
      ctx.ui.notify(r.text, r.ok ? "info" : "warning");
    },
  });
  pi.registerCommand("secret-exec", {
    description: "Run a command with a secret as env (usage: /secret-exec NAME program arg...)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const name = parts[0] || "";
      const bad = checkName(name);
      if (bad || parts.length < 2) {
        ctx.ui.notify("Usage: /secret-exec NAME program arg...", "warning");
        return;
      }
      const value = load().get(name);
      if (value === undefined) {
        ctx.ui.notify(`${name} not stored. Use /secret-drop ${name} first.`, "warning");
        return;
      }
      const r = await runWithSecret(name, value, parts.slice(1), ctx.cwd);
      ctx.ui.notify(`exit ok=${r.ok}\n${(r.out + r.err).slice(-2000)}`, r.ok ? "info" : "error");
    },
  });
}
