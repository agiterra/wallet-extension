#!/usr/bin/env bun
/**
 * Tiny static-file server for the smoke-test HTML page. Serves
 * test/test-page.html at http://localhost:54322. Keeps everything
 * over http://localhost so file:// CORS issues don't bite.
 *
 *   bun scripts/test-page-server.ts
 *   open http://localhost:54322
 */

const PORT = Number(process.env.PORT ?? 54322);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/test-page.html") {
      const file = Bun.file(`${import.meta.dir}/../test/test-page.html`);
      return new Response(file, { headers: { "Content-Type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[test-page] serving http://127.0.0.1:${server.port}/`);
