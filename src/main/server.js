import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { existsSync, unlinkSync } from "node:fs";

const MAX_BODY = 8 * 1024 * 1024;

// Both sides prove they know the secret without sending it. Each proof names
// its purpose, so a proof made for one step cannot stand in for another, and a
// decision's proof covers the exact text of the decision.
const sign = (token, ...parts) => createHmac("sha256", token).update(parts.join(":")).digest("hex");
const digest = (text) => createHash("sha256").update(text).digest("hex");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Receives hook events over a local pipe. Background events are acknowledged at
// once. Permission requests and questions are held open until the interface
// answers, the hold runs out, or the other side goes away.
export function createHookServer({ pipePath, token = "", onEvent, onHeld, routes = {} }) {
  const knowsSecret = (nonce, client) => Boolean(token) && typeof nonce === "string" && nonce.length > 0 && same(client, sign(token, "client", nonce));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const client = req.headers["x-agents-huddle-client"];

    if (req.method === "GET") {
      const nonce = url.searchParams.get("nonce");
      if (!knowsSecret(nonce, client)) return res.writeHead(403).end();
      if (url.pathname === "/hello") return res.writeHead(204, { "x-agents-huddle-proof": sign(token, "hello", nonce) }).end();
      if (routes[url.pathname]) return routes[url.pathname](req, res, url);
      return res.writeHead(404).end();
    }

    const kind = /^\/hook\/(event|permission|question)$/.exec(url.pathname)?.[1];
    const nonce = req.headers["x-agents-huddle-nonce"];
    if (req.method !== "POST" || !kind || !knowsSecret(nonce, client)) {
      res.writeHead(kind ? 403 : 404).end();
      req.resume();
      return;
    }

    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (kind === "event") {
        res.writeHead(204).end();
        onEvent(payload);
        return;
      }
      let settled = false;
      const held = {
        kind,
        payload,
        onGone: null,
        respond(body) {
          if (settled) return;
          settled = true;
          if (!body) return res.writeHead(204).end();
          const text = JSON.stringify(body);
          res.writeHead(200, { "content-type": "application/json", "x-agents-huddle-proof": sign(token, "decision", nonce, digest(text)) }).end(text);
        },
      };
      res.on("close", () => {
        if (settled) return;
        settled = true;
        held.onGone?.();
      });
      onHeld(held);
    });
  });

  return {
    listen() {
      if (process.platform !== "win32" && existsSync(pipePath)) unlinkSync(pipePath);
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(pipePath, () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
