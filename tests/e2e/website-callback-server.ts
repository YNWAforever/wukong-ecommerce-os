/** Test-only Node callback adapter. Never imported by the application. */
import { createServer } from "node:http";
import { createDatabase } from "../../packages/db/src/client.js";
import { createWebsiteDocumentHandler } from "../../apps/web/app/api/internal/website-document/route.js";
import type { PublicFetch } from "../../apps/web/lib/website/public-fetch.js";
if (
  process.env.WUKONG_REAL_STACK_SERVER !== "1" ||
  !process.env.TEST_DATABASE_URL
)
  throw new Error("Explicit real-stack test environment required");
const database = createDatabase(process.env.TEST_DATABASE_URL);
const publicFetch: PublicFetch = async ({ url, signal }) => {
  signal.throwIfAborted();
  const target = new URL(url);
  if (target.hostname !== "website.synthetic.example")
    throw new Error("Unknown synthetic fixture host");
  let text = "",
    status = 200;
  if (target.pathname === "/robots.txt") text = "User-agent: *\nAllow: /\n";
  else if (target.pathname === "/" || target.pathname === "/partial")
    text = `<html><a href="/products/bottle">Bottle</a>${target.pathname === "/partial" ? '<a href="/products/missing">Missing</a>' : ""}</html>`;
  else if (target.pathname === "/products/bottle")
    text = `<html><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Sample bottle", description: "Synthetic bottle description", url, image: "https://website.synthetic.example/image.jpg", brand: { "@type": "Brand", name: "Synthetic brand" }, offers: { "@type": "Offer", price: "128.00", priceCurrency: "HKD", availability: "https://schema.org/InStock" } })}</script></html>`;
  else status = 404;
  return {
    url,
    status,
    contentType: target.pathname === "/robots.txt" ? "text/plain" : "text/html",
    text,
    capturedAt: new Date().toISOString(),
    retryAfterSeconds: null,
  };
};
const handler = createWebsiteDocumentHandler({
  secret: () => process.env.QUEUE_INGRESS_SECRET,
  getDatabase: () => database,
  publicFetch,
});
const server = createServer(async (incoming, outgoing) => {
  try {
    if (incoming.url === "/health") {
      outgoing.writeHead(200).end("ok");
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of incoming) {
      bytes += chunk.length;
      if (bytes > 4096) {
        outgoing.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers))
      if (value)
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const response = await handler(
      new Request(`http://127.0.0.1:49219${incoming.url}`, {
        method: incoming.method,
        headers,
        ...(incoming.method !== "GET" && incoming.method !== "HEAD"
          ? { body: Buffer.concat(chunks) }
          : {}),
      }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  } catch {
    outgoing.writeHead(500).end("callback_failure");
  }
});
server.listen(49219, "127.0.0.1");
async function stop() {
  server.close();
  await database.close();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
