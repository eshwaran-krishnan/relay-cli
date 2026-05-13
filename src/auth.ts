import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";

export type Credential = {
  host: string;
  token: string;
  user_email?: string;
  agent_id?: string;
  created_at: string;
};

const CONFIG_DIR = join(homedir(), ".relay");
const CRED_PATH = join(CONFIG_DIR, "credentials");

export function loadCredential(): Credential | null {
  try {
    const raw = readFileSync(CRED_PATH, "utf-8");
    return JSON.parse(raw) as Credential;
  } catch {
    // legacy: ~/.relay/key (paste-key login from earlier CLI)
    try {
      const legacy = readFileSync(join(CONFIG_DIR, "key"), "utf-8").trim();
      if (legacy) {
        return {
          host: process.env.RELAY_URL ?? "https://relaymesh.io",
          token: legacy,
          created_at: new Date().toISOString(),
        };
      }
    } catch {
      // fall through
    }
    return null;
  }
}

export function saveCredential(cred: Credential): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CRED_PATH, JSON.stringify(cred, null, 2));
  // 0600 — owner read/write only
  chmodSync(CRED_PATH, 0o600);
}

export function clearCredential(): void {
  for (const p of [CRED_PATH, join(CONFIG_DIR, "key")]) {
    if (existsSync(p)) unlinkSync(p);
  }
}

// ─── PKCE helpers (RFC 7636) ────────────────────────────────────────────────
// Used by the browser-based login flow. Public-client OAuth: no client_secret,
// the verifier proves we're the same caller who initiated the auth request.

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ─── Browser-based login (localhost callback) ───────────────────────────────
// Spins up an ephemeral HTTP listener on 127.0.0.1, opens the user's browser
// to <hub>/cli/authorize, waits for the redirect, exchanges the code, writes
// the credential.
//
// HUB CONTRACT (not yet implemented on the hub):
//   GET  /cli/authorize?client_id=relay-cli&code_challenge=…&redirect_uri=…&state=…
//        → user signs in, hub redirects to redirect_uri?code=…&state=…
//   POST /cli/token { code, code_verifier, redirect_uri }
//        → { token, user_email, agent_id }

export const CLIENT_ID = "relay-cli";

export async function browserLogin(hubUrl: string): Promise<Credential> {
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));

  const { port, codePromise } = await startCallbackServer(state);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const authUrl = new URL(`${hubUrl}/cli/authorize`);
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);

  console.log(`Opening ${authUrl.toString()} in your browser…`);
  await openBrowser(authUrl.toString());

  const code = await codePromise;

  const tokenRes = await fetch(`${hubUrl}/cli/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const body = (await tokenRes.json()) as { token: string; user_email?: string; agent_id?: string };

  const cred: Credential = {
    host: hubUrl,
    token: body.token,
    user_email: body.user_email,
    agent_id: body.agent_id,
    created_at: new Date().toISOString(),
  };
  saveCredential(cred);
  return cred;
}

async function startCallbackServer(
  expectedState: string,
): Promise<{ port: number; codePromise: Promise<string> }> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const reply = (res: ServerResponse, message: string, status = 200): void => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(htmlPage(message));
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
      rejectCode(new Error("State mismatch — possible CSRF"));
    } else if (!code) {
      reply(res, "No code returned. You can close this tab.", 400);
      rejectCode(new Error("No code returned"));
    } else {
      reply(res, "You're signed in. You can close this tab.");
      resolveCode(code);
    }

    // Close after the response flushes so the user sees the page.
    res.on("finish", () => server.close());
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, codePromise });
    });
  });
}

function htmlPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>relay</title>
<body style="font:16px -apple-system,Segoe UI,Inter,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#fafaf7;color:#222">
<div style="text-align:center"><h1 style="font-weight:500;letter-spacing:-0.01em">relay</h1><p>${message}</p></div>`;
}

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    console.log(`Open this URL manually: ${url}`);
  }
}
