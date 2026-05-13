// relay — command-line client for relaymesh.io
//
// Thin HTTP client. After `relay login`, every other command picks up your
// credential from ~/.relay/credentials. Agents on the same machine inherit
// your identity by invoking this CLI.

import { createRequire } from "node:module";
import { mcpCall, api, hubUrl } from "./client.ts";
import {
  browserLogin,
  clearCredential,
  loadCredential,
  saveCredential,
} from "./auth.ts";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };
const VERSION: string = packageJson.version;

const args = process.argv.slice(2);
const cmd = args[0];

function usage(): void {
  console.log(`
  relay — command-line client for relaymesh.io

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

async function main(): Promise<void> {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage();
    return;
  }

  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(`relay ${VERSION}`);
    return;
  }

  // ─── login ───────────────────────────────────────────────────────────
  if (cmd === "login") {
    const arg = args[1];
    if (arg) {
      // Paste-key fallback: `relay login amk_…`
      saveCredential({
        host: hubUrl(),
        token: arg.trim(),
        created_at: new Date().toISOString(),
      });
      console.log("Logged in. Credential saved to ~/.relay/credentials");
      return;
    }
    try {
      const cred = await browserLogin(hubUrl());
      console.log(`Logged in${cred.user_email ? ` as ${cred.user_email}` : ""}.`);
      console.log("Credential saved to ~/.relay/credentials");
    } catch (e) {
      console.error(`Login failed: ${(e as Error).message}`);
      console.error("Fallback: paste a key with  relay login <key>");
      process.exit(1);
    }
    return;
  }

  // ─── logout ──────────────────────────────────────────────────────────
  if (cmd === "logout") {
    clearCredential();
    console.log("Logged out.");
    return;
  }

  // Everything below needs an auth credential.
  if (!process.env.RELAY_KEY && !loadCredential()) {
    console.error("Not logged in. Run: relay login");
    process.exit(1);
  }

  // ─── status ──────────────────────────────────────────────────────────
  if (cmd === "status") {
    const agents = (await mcpCall("discover_agents", {})) as Array<{
      id: string;
      name: string;
      status: string;
      tags?: string[];
    }>;
    if (agents.length === 0) {
      console.log("No agents online.");
      return;
    }
    console.log(`\n${agents.length} agent(s) on the network:\n`);
    for (const a of agents) {
      const dot = a.status === "online" ? "●" : "○";
      const tags = a.tags?.length ? ` [${a.tags.join(", ")}]` : "";
      console.log(`  ${dot} ${a.name} (${a.id})${tags}`);
    }
    console.log();
    return;
  }

  // ─── send ────────────────────────────────────────────────────────────
  if (cmd === "send") {
    const to = args[1];
    const msg = args.slice(2).join(" ");
    if (!to || !msg) {
      console.error("Usage: relay send <agent-id> <message>");
      process.exit(1);
    }
    const r = (await mcpCall("send_message", { to, content: msg })) as {
      error?: string;
      queued?: boolean;
    };
    if (r.error) {
      console.error(`Error: ${r.error}`);
      process.exit(1);
    }
    console.log(r.queued ? "Message queued (agent offline)." : "Message sent.");
    return;
  }

  // ─── delegate ────────────────────────────────────────────────────────
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
      timestamp: new Date().toISOString(),
    };
    const r = (await mcpCall("send_message", {
      to,
      content: JSON.stringify(task),
    })) as { error?: string };
    if (r.error) {
      console.error(`Error: ${r.error}`);
      process.exit(1);
    }
    console.log(`Task delegated to ${to}.`);
    return;
  }

  // ─── messages ────────────────────────────────────────────────────────
  if (cmd === "messages") {
    const r = (await mcpCall("check_messages", {})) as {
      count: number;
      messages: Array<{ from_agent?: string; content: unknown; timestamp: string }>;
    };
    if (r.count === 0) {
      console.log("No messages.");
      return;
    }
    console.log(`\n${r.count} message(s):\n`);
    for (const msg of r.messages) {
      const from = msg.from_agent ?? "unknown";
      const preview =
        typeof msg.content === "string"
          ? msg.content.slice(0, 80)
          : JSON.stringify(msg.content).slice(0, 80);
      console.log(`  [${msg.timestamp}] from ${from}: ${preview}`);
    }
    console.log();
    return;
  }

  // ─── channels ────────────────────────────────────────────────────────
  if (cmd === "channels") {
    const channels = (await mcpCall("list_channels", {})) as Array<{
      name: string;
      subscriber_count: number;
    }>;
    if (channels.length === 0) {
      console.log("No channels.");
      return;
    }
    console.log(`\n${channels.length} channel(s):\n`);
    for (const ch of channels) {
      console.log(`  #${ch.name} — ${ch.subscriber_count} subscribers`);
    }
    console.log();
    return;
  }

  // ─── keys ────────────────────────────────────────────────────────────
  if (cmd === "keys") {
    const sub = args[1];

    if (sub === "create") {
      const name = args[2];
      if (!name) {
        console.error("Usage: relay keys create <name>");
        process.exit(1);
      }
      const res = (await api("POST", "/api/keys", {
        name,
        permissions: ["send", "receive", "subscribe", "broadcast", "artifacts"],
      })) as { error?: string; name?: string; key?: string };
      if (res.error) {
        console.error(`Error: ${res.error}`);
        process.exit(1);
      }
      console.log(`\nKey created for "${res.name}":\n\n  ${res.key}\n`);
      return;
    }

    if (sub === "list") {
      const keys = (await api("GET", "/api/keys")) as
        | { error: string }
        | Array<{
            key_prefix: string;
            name: string;
            permissions: string[];
            revoked_at: string | null;
          }>;
      if ("error" in keys) {
        console.error(`Error: ${keys.error}`);
        process.exit(1);
      }
      if (keys.length === 0) {
        console.log("No keys.");
        return;
      }
      console.log(`\n${keys.length} key(s):\n`);
      for (const k of keys) {
        const status = k.revoked_at ? " (revoked)" : "";
        console.log(
          `  ${k.key_prefix}... — ${k.name} [${k.permissions.join(",")}]${status}`,
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
      const res = (await api("DELETE", `/api/keys/${agentId}`)) as { error?: string };
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

main().catch((e: Error & { code?: string }) => {
  if (e.code === "ECONNREFUSED") {
    console.error(`Can't connect to hub at ${hubUrl()}.`);
  } else {
    console.error(`Error: ${e.message}`);
  }
  process.exit(1);
});
