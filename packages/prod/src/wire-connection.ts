/**
 * WireConnection — the wallet-vault extension's connection to The Wire.
 *
 * Responsibilities:
 *   1. Self-register with Wire as kind='integration' on first connect (if not
 *      already known). Self-register requires sponsor/operator auth — when
 *      the extension's pubkey isn't yet on file, Wire returns 401/403; the
 *      operator must run the one-shot curl logged by wire-identity.ts to
 *      enroll the pubkey. We retry forever; once registered, we proceed.
 *   2. Open an SSE stream on /agents/wallet-vault/stream and dispatch events
 *      to subscribers (the WireDecider).
 *   3. Publish JWT-signed messages to topics via POST /broadcast/:topic or
 *      /webhooks/:dest/:topic.
 *   4. Reconnect on drop with backoff.
 *
 * Lives in the MV3 service worker. While the SSE stream is open, the SW
 * stays alive — incoming events naturally extend its lifetime.
 */

import type { WireIdentity } from "./wire-identity.js";
import { createAuthJwt } from "./wire-crypto.js";

const WIRE_URL_KEY = "agiterra-wallet-extension-wire-url";

interface WireEvent {
  seq: number;
  source: string;
  topic: string;
  payload: unknown;
  dest?: string | null;
  created_at: number;
}

type EventHandler = (event: WireEvent) => void;

export class WireConnection {
  private wireUrl: string | null = null;
  private sessionId: string | null = null;
  private handlers = new Set<EventHandler>();
  private abortController: AbortController | null = null;
  private started = false;
  private stopped = false;
  private registered = false;

  constructor(private identity: WireIdentity) {}

  /**
   * Kick off the connection loop. Idempotent. Returns immediately; the loop
   * runs in the background. Subscribe via {@link onEvent} before or after.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.abortController?.abort();
  }

  /** Subscribe to wire events. Returns an unsubscribe function. */
  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Write a value into Wire's plugin_settings KV. Auth: this extension's
   * JWT is accepted when the URL namespace matches the extension's agent
   * ID (i.e. the wallet-vault integration writes the "wallet-vault"
   * namespace). Used for boot-time seeding of the wallet directory and
   * for vault mutations (create/rename) triggered by MCP tools.
   */
  async setPluginSetting(namespace: string, key: string, value: unknown): Promise<void> {
    // The loop sets this.wireUrl lazily after first storage read. Callers may
    // race in before the loop has gotten that far — pull from storage on demand
    // so we don't throw spuriously on the first boot.
    if (!this.wireUrl) await this.resolveWireUrl();
    if (!this.wireUrl) throw new Error("Wire URL not configured");
    const body = JSON.stringify({ value });
    const headers = await this.jwtHeaders(body);
    const res = await fetch(`${this.wireUrl}/plugin_settings/${namespace}/${key}`, {
      method: "PUT",
      headers,
      body,
    });
    if (!res.ok) {
      throw new Error(`plugin_settings PUT failed (${res.status}): ${await res.text().catch(() => "")}`);
    }
  }

  /**
   * Publish a JWT-signed message to a topic. `dest` (optional) sends it
   * directly to a single agent; omitted = broadcast.
   */
  async publish(topic: string, payload: unknown, dest?: string): Promise<{ seq: number }> {
    if (!this.wireUrl) throw new Error("Wire URL not configured yet (see chrome.storage.local key '" + WIRE_URL_KEY + "')");
    const body = JSON.stringify(payload);
    const headers = await this.jwtHeaders(body);
    const endpoint = dest
      ? `${this.wireUrl}/webhooks/${dest}/${topic}`
      : `${this.wireUrl}/broadcast/${topic}`;
    const res = await fetch(endpoint, { method: "POST", headers, body });
    if (!res.ok) {
      throw new Error(`Wire publish failed (${res.status}): ${await res.text().catch(() => "")}`);
    }
    return (await res.json()) as { seq: number };
  }

  // ---- internals ----

  private async jwtHeaders(body: string): Promise<Record<string, string>> {
    const token = await createAuthJwt(this.identity.privateKey, this.identity.agentId, body);
    return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  }

  private async loop(): Promise<void> {
    let backoffMs = 1000;
    while (!this.stopped) {
      try {
        await this.resolveWireUrl();
        await this.ensureRegistered();
        await this.ensureConnected();
        await this.streamOnce();
        // Stream ended cleanly (server restart, etc.) — reconnect from scratch.
        this.sessionId = null;
        backoffMs = 1000;
      } catch (e) {
        const err = e as Error;
        console.warn(`[wallet-vault] Wire connection error: ${err.message}; retrying in ${backoffMs}ms`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  private async resolveWireUrl(): Promise<void> {
    if (this.wireUrl) return;
    const stored = await chrome.storage.local.get(WIRE_URL_KEY);
    const url = (stored[WIRE_URL_KEY] as string | undefined)?.replace(/\/$/, "");
    if (!url) {
      throw new Error(
        `Wire URL not set. Set chrome.storage.local['${WIRE_URL_KEY}'] = "https://the-wire.example/" via service-worker devtools.`,
      );
    }
    this.wireUrl = url;
    console.log(`[wallet-vault] Wire URL resolved: ${this.wireUrl}`);
  }

  private async ensureRegistered(): Promise<void> {
    if (this.registered) return;
    // Try self-register. This will succeed on subsequent boots after operator
    // has enrolled our pubkey (and fail loudly the first time so the operator
    // sees the curl in console.log).
    const body = JSON.stringify({
      id: this.identity.agentId,
      display_name: this.identity.displayName,
      pubkey: this.identity.publicKeyB64,
      kind: "integration",
    });
    const res = await fetch(`${this.wireUrl}/agents/register`, {
      method: "POST",
      headers: await this.jwtHeaders(body),
      body,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Wire rejected self-register (${res.status}). Operator must enroll our pubkey first — see the one-time curl logged on extension install.`,
      );
    }
    if (!res.ok) {
      throw new Error(`Wire register failed (${res.status}): ${await res.text().catch(() => "")}`);
    }
    this.registered = true;
    console.log(`[wallet-vault] Wire register OK (kind=integration)`);
  }

  private async ensureConnected(): Promise<void> {
    if (this.sessionId) return;
    const body = JSON.stringify({});
    const res = await fetch(`${this.wireUrl}/agents/connect`, {
      method: "POST",
      headers: await this.jwtHeaders(body),
      body,
    });
    if (!res.ok) {
      throw new Error(`Wire connect failed (${res.status}): ${await res.text().catch(() => "")}`);
    }
    const data = (await res.json()) as { session_id: string };
    this.sessionId = data.session_id;
    console.log(`[wallet-vault] Wire connected: session=${this.sessionId}`);
  }

  private async streamOnce(): Promise<void> {
    if (!this.sessionId) throw new Error("streamOnce called without session");
    const streamUrl = `${this.wireUrl}/agents/${this.identity.agentId}/stream?session_id=${this.sessionId}`;
    this.abortController = new AbortController();
    const res = await fetch(streamUrl, {
      signal: this.abortController.signal,
      headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
    });
    if (!res.ok || !res.body) {
      if (res.status === 403 || res.status === 404 || res.status >= 500) this.sessionId = null;
      throw new Error(`SSE failed (${res.status})`);
    }
    console.log(`[wallet-vault] SSE stream open`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) {
          console.log(`[wallet-vault] SSE stream ended by server`);
          break;
        }
        buf += decoder.decode(value, { stream: true });
        // SSE frames are separated by blank lines.
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          this.processFrame(frame);
        }
      }
    } finally {
      this.abortController = null;
      try { reader.releaseLock(); } catch {}
    }
  }

  private processFrame(frame: string): void {
    // Each frame is multiple "field: value" lines. We only care about `data:`.
    let dataLine = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) dataLine += line.slice(5).trimStart();
    }
    if (!dataLine) return;
    let parsed: WireEvent;
    try {
      parsed = JSON.parse(dataLine) as WireEvent;
    } catch (e) {
      console.warn(`[wallet-vault] SSE frame parse error: ${(e as Error).message}`);
      return;
    }
    for (const h of this.handlers) {
      try { h(parsed); } catch (e) {
        console.error(`[wallet-vault] event handler threw:`, e);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
