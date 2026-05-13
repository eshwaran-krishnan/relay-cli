#!/usr/bin/env node

// src/index.ts
import { createRequire } from "node:module";

// src/auth.ts
import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
var CONFIG_DIR = join(homedir(), ".relay");
var CRED_PATH = join(CONFIG_DIR, "credentials");
function loadCredential() {
  try {
    const raw = readFileSync(CRED_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    try {
      const legacy = readFileSync(join(CONFIG_DIR, "key"), "utf-8").trim();
      if (legacy) {
        return {
          host: process.env.RELAY_URL ?? "https://relaymesh.io",
          token: legacy,
          created_at: (/* @__PURE__ */ new Date()).toISOString()
        };
      }
    } catch {
    }
    return null;
  }
}
function saveCredential(cred) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CRED_PATH, JSON.stringify(cred, null, 2));
  chmodSync(CRED_PATH, 384);
}
function clearCredential() {
  for (const p of [CRED_PATH, join(CONFIG_DIR, "key")]) {
    if (existsSync(p)) unlinkSync(p);
  }
}
function pkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
var CLIENT_ID = "relay-cli";
async function browserLogin(hubUrl2) {
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));
  const { port, codePromise } = await startCallbackServer(state);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authUrl = new URL(`${hubUrl2}/cli/authorize`);
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  console.log(`Opening ${authUrl.toString()} in your browser\u2026`);
  await openBrowser(authUrl.toString());
  const code = await codePromise;
  const tokenRes = await fetch(`${hubUrl2}/cli/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID
    })
  });
  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const body = await tokenRes.json();
  const cred = {
    host: hubUrl2,
    token: body.token,
    user_email: body.user_email,
    agent_id: body.agent_id,
    created_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  saveCredential(cred);
  return cred;
}
async function startCallbackServer(expectedState) {
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const reply = (res, message, status = 200) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(htmlPage(message));
  };
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/callback") {
      res.writeHead(404).end("Not found");
      return;
    }
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state");
    const error = u.searchParams.get("error");
    if (error) {
      reply(res, "Authorization denied. You can close this tab.");
      rejectCode(new Error(`Authorization denied: ${error}`));
    } else if (state !== expectedState) {
      reply(res, "State mismatch. You can close this tab.", 400);
      rejectCode(new Error("State mismatch \u2014 possible CSRF"));
    } else if (!code) {
      reply(res, "No code returned. You can close this tab.", 400);
      rejectCode(new Error("No code returned"));
    } else {
      reply(res, "You're signed in. You can close this tab.");
      resolveCode(code);
    }
    res.on("finish", () => server.close());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ port, codePromise });
    });
  });
}
function htmlPage(message) {
  return `<!doctype html><meta charset="utf-8"><title>relay</title>
<body style="font:16px -apple-system,Segoe UI,Inter,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#fafaf7;color:#222">
<div style="text-align:center"><h1 style="font-weight:500;letter-spacing:-0.01em">relay</h1><p>${message}</p></div>`;
}
async function openBrowser(url) {
  const platform = process.platform;
  const cmd2 = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd2, [url], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    console.log(`Open this URL manually: ${url}`);
  }
}

// src/client.ts
var DEFAULT_HUB_URL = "https://relaymesh.io";
function hubUrl() {
  return process.env.RELAY_URL ?? DEFAULT_HUB_URL;
}
function authHeaders() {
  const h = { "Content-Type": "application/json" };
  const key = process.env.RELAY_KEY ?? loadCredential()?.token;
  if (key) h["Authorization"] = `Bearer ${key}`;
  return h;
}
async function mcpCall(tool, toolArgs) {
  const res = await fetch(`${hubUrl()}/mcp`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: toolArgs }
    })
  });
  const data = await res.json();
  if (data.error) {
    console.error(`Error: ${data.error.message}`);
    process.exit(1);
  }
  const text = data.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : data.result;
}
async function api(method, path, body) {
  const res = await fetch(`${hubUrl()}${path}`, {
    method,
    headers: authHeaders(),
    ...body ? { body: JSON.stringify(body) } : {}
  });
  return await res.json();
}

// src/index.ts
var require2 = createRequire(import.meta.url);
var packageJson = require2("../package.json");
var VERSION = packageJson.version;
var args = process.argv.slice(2);
var cmd = args[0];
function usage() {
  console.log(`
  relay \u2014 command-line client for relaymesh.io

  Usage:
    relay login                       Authenticate this machine (opens browser)
    relay login <key>                 Paste an API key instead of using the browser
    relay logout                      Forget the stored credential
    relay status                      Show online agents
    relay send <agent-id> <message>   Send a direct message
    relay delegate <agent-id> <goal>  Delegate a task
    relay messages                    Check queued messages
    relay channels                    List channels
    relay keys create <name>          Create a new agent key
    relay keys list                   List all keys
    relay keys revoke <agent-id>      Revoke a key
    relay --version                   Print version

  Environment:
    RELAY_URL    Override the hub URL (default: https://relaymesh.io)
    RELAY_KEY    Override the stored credential for this invocation
`);
}
async function main() {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage();
    return;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(`relay ${VERSION}`);
    return;
  }
  if (cmd === "login") {
    const arg = args[1];
    if (arg) {
      saveCredential({
        host: hubUrl(),
        token: arg.trim(),
        created_at: (/* @__PURE__ */ new Date()).toISOString()
      });
      console.log("Logged in. Credential saved to ~/.relay/credentials");
      return;
    }
    try {
      const cred = await browserLogin(hubUrl());
      console.log(`Logged in${cred.user_email ? ` as ${cred.user_email}` : ""}.`);
      console.log("Credential saved to ~/.relay/credentials");
    } catch (e) {
      console.error(`Login failed: ${e.message}`);
      console.error("Fallback: paste a key with  relay login <key>");
      process.exit(1);
    }
    return;
  }
  if (cmd === "logout") {
    clearCredential();
    console.log("Logged out.");
    return;
  }
  if (!process.env.RELAY_KEY && !loadCredential()) {
    console.error("Not logged in. Run: relay login");
    process.exit(1);
  }
  if (cmd === "status") {
    const agents = await mcpCall("discover_agents", {});
    if (agents.length === 0) {
      console.log("No agents online.");
      return;
    }
    console.log(`
${agents.length} agent(s) on the network:
`);
    for (const a of agents) {
      const dot = a.status === "online" ? "\u25CF" : "\u25CB";
      const tags = a.tags?.length ? ` [${a.tags.join(", ")}]` : "";
      console.log(`  ${dot} ${a.name} (${a.id})${tags}`);
    }
    console.log();
    return;
  }
  if (cmd === "send") {
    const to = args[1];
    const msg = args.slice(2).join(" ");
    if (!to || !msg) {
      console.error("Usage: relay send <agent-id> <message>");
      process.exit(1);
    }
    const r = await mcpCall("send_message", { to, content: msg });
    if (r.error) {
      console.error(`Error: ${r.error}`);
      process.exit(1);
    }
    console.log(r.queued ? "Message queued (agent offline)." : "Message sent.");
    return;
  }
  if (cmd === "delegate") {
    const to = args[1];
    const goal = args.slice(2).join(" ");
    if (!to) {
      console.error("Usage: relay delegate <agent-id> <goal>");
      process.exit(1);
    }
    const task = {
      type: "task_delegation",
      goal: goal || "No goal specified",
      from: "cli",
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    const r = await mcpCall("send_message", {
      to,
      content: JSON.stringify(task)
    });
    if (r.error) {
      console.error(`Error: ${r.error}`);
      process.exit(1);
    }
    console.log(`Task delegated to ${to}.`);
    return;
  }
  if (cmd === "messages") {
    const r = await mcpCall("check_messages", {});
    if (r.count === 0) {
      console.log("No messages.");
      return;
    }
    console.log(`
${r.count} message(s):
`);
    for (const msg of r.messages) {
      const from = msg.from_agent ?? "unknown";
      const preview = typeof msg.content === "string" ? msg.content.slice(0, 80) : JSON.stringify(msg.content).slice(0, 80);
      console.log(`  [${msg.timestamp}] from ${from}: ${preview}`);
    }
    console.log();
    return;
  }
  if (cmd === "channels") {
    const channels = await mcpCall("list_channels", {});
    if (channels.length === 0) {
      console.log("No channels.");
      return;
    }
    console.log(`
${channels.length} channel(s):
`);
    for (const ch of channels) {
      console.log(`  #${ch.name} \u2014 ${ch.subscriber_count} subscribers`);
    }
    console.log();
    return;
  }
  if (cmd === "keys") {
    const sub = args[1];
    if (sub === "create") {
      const name = args[2];
      if (!name) {
        console.error("Usage: relay keys create <name>");
        process.exit(1);
      }
      const res = await api("POST", "/api/keys", {
        name,
        permissions: ["send", "receive", "subscribe", "broadcast", "artifacts"]
      });
      if (res.error) {
        console.error(`Error: ${res.error}`);
        process.exit(1);
      }
      console.log(`
Key created for "${res.name}":

  ${res.key}
`);
      return;
    }
    if (sub === "list") {
      const keys = await api("GET", "/api/keys");
      if ("error" in keys) {
        console.error(`Error: ${keys.error}`);
        process.exit(1);
      }
      if (keys.length === 0) {
        console.log("No keys.");
        return;
      }
      console.log(`
${keys.length} key(s):
`);
      for (const k of keys) {
        const status = k.revoked_at ? " (revoked)" : "";
        console.log(
          `  ${k.key_prefix}... \u2014 ${k.name} [${k.permissions.join(",")}]${status}`
        );
      }
      console.log();
      return;
    }
    if (sub === "revoke") {
      const agentId = args[2];
      if (!agentId) {
        console.error("Usage: relay keys revoke <agent-id>");
        process.exit(1);
      }
      const res = await api("DELETE", `/api/keys/${agentId}`);
      if (res.error) {
        console.error(`Error: ${res.error}`);
        process.exit(1);
      }
      console.log(`Key revoked for agent ${agentId}.`);
      return;
    }
    console.error("Usage: relay keys [create|list|revoke]");
    process.exit(1);
  }
  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(1);
}
main().catch((e) => {
  if (e.code === "ECONNREFUSED") {
    console.error(`Can't connect to hub at ${hubUrl()}.`);
  } else {
    console.error(`Error: ${e.message}`);
  }
  process.exit(1);
});
