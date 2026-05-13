import { loadCredential } from "./auth.ts";

export const DEFAULT_HUB_URL = "https://relaymesh.io";

export function hubUrl(): string {
  return process.env.RELAY_URL ?? DEFAULT_HUB_URL;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const key = process.env.RELAY_KEY ?? loadCredential()?.token;
  if (key) h["Authorization"] = `Bearer ${key}`;
  return h;
}

export async function mcpCall(
  tool: string,
  toolArgs: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${hubUrl()}/mcp`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: toolArgs },
    }),
  });
  const data = (await res.json()) as {
    error?: { message: string };
    result?: { content?: Array<{ text?: string }> };
  };
  if (data.error) {
    console.error(`Error: ${data.error.message}`);
    process.exit(1);
  }
  const text = data.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : data.result;
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${hubUrl()}${path}`, {
    method,
    headers: authHeaders(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return (await res.json()) as T;
}
