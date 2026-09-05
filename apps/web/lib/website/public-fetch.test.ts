import { describe, expect, it, vi } from "vitest";
import { createPublicFetch, type PublicFetch } from "./public-fetch";
const input = (url = "https://store.example/", extra = {}) => ({
  url,
  kind: "discovery" as const,
  lockedOrigin: null,
  signal: new AbortController().signal,
  ...extra,
});
const ok = () => ({
  status: 200,
  contentType: "text/html",
  body: ["<p>ok</p>"],
});
function setup(addresses = ["93.184.216.34"]) {
  const request = vi.fn(async () => ok());
  const resolve = vi.fn(async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    })),
  );
  return { request, resolve, fetch: createPublicFetch({ resolve, request }) };
}
describe("public document boundary", () => {
  it.each([
    "http://store.example",
    "https://u:p@store.example",
    "https://store.example:444",
    "https://localhost",
    "https://foo.local",
    "https://service.internal",
    "https://2130706433",
    "https://0x7f000001",
    "https://127.1",
    "https://0177.0.0.1",
    "https://[::ffff:8.8.8.8]",
  ])("rejects unsafe URL %s without DNS or connection", async (url) => {
    const s = setup();
    await expect(s.fetch(input(url))).rejects.toHaveProperty("code");
    expect(s.request).not.toHaveBeenCalled();
    expect(s.resolve).not.toHaveBeenCalled();
  });
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.1.1.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:93.184.216.34",
    "2002:0808:0808::1",
  ])("never dials reserved address %s", async (address) => {
    const s = setup([address]);
    await expect(s.fetch(input())).rejects.toHaveProperty(
      "code",
      "unsafe_address",
    );
    expect(s.request).not.toHaveBeenCalled();
  });
  it("rejects mixed DNS answers", async () => {
    const s = setup(["93.184.216.34", "10.0.0.1"]);
    await expect(s.fetch(input())).rejects.toHaveProperty(
      "code",
      "unsafe_address",
    );
    expect(s.request).not.toHaveBeenCalled();
  });
  it("pins the first validated answer without a later lookup and preserves query", async () => {
    const s = setup();
    const result = await s.fetch(input("https://store.example/p?v=red#x"));
    expect(s.resolve).toHaveBeenCalledTimes(1);
    expect(s.request).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "store.example",
        address: "93.184.216.34",
        family: 4,
        path: "/p?v=red",
      }),
    );
    expect(result.url).toBe("https://store.example/p?v=red");
  });
  it.each([
    "http://store.example/a",
    "https://elsewhere.example/a",
    "https://127.0.0.1/a",
  ])("rejects redirect %s", async (location) => {
    const s = setup();
    s.request.mockResolvedValue({
      ...ok(),
      status: 302,
      location,
    } as ReturnType<typeof ok>);
    await expect(s.fetch(input())).rejects.toHaveProperty("code");
    expect(s.request).toHaveBeenCalledTimes(1);
  });
  it("allows initial apex/www canonicalization only", async () => {
    const s = setup();
    s.request.mockResolvedValueOnce({
      ...ok(),
      status: 301,
      location: "https://www.store.example/a",
    } as ReturnType<typeof ok>);
    expect(await s.fetch(input())).toMatchObject({
      url: "https://store.example/",
      redirectedTo: "https://www.store.example/a",
    });
    await expect(
      s.fetch(
        input("https://www.store.example/p", {
          kind: "product",
          lockedOrigin: "https://store.example",
        }),
      ),
    ).rejects.toHaveProperty("code", "origin_mismatch");
  });
  it("rejects a fourth redirect", async () => {
    const s = setup();
    s.request.mockResolvedValue({
      ...ok(),
      status: 302,
      location: "/a",
    } as ReturnType<typeof ok>);
    await expect(s.fetch(input())).rejects.toHaveProperty(
      "code",
      "too_many_redirects",
    );
    expect(s.request).toHaveBeenCalledTimes(4);
  });
  it("caps body and cancels on overflow", async () => {
    const cancel = vi.fn();
    const fetch = createPublicFetch({
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      request: async () => ({
        ...ok(),
        body: [Buffer.alloc(2 * 1024 * 1024 + 1)],
        cancel,
      }),
    });
    await expect(fetch(input())).rejects.toHaveProperty(
      "code",
      "body_too_large",
    );
    expect(cancel).toHaveBeenCalled();
  });
  it("rejects compression and unsupported content", async () => {
    for (const response of [
      { ...ok(), contentEncoding: "gzip" },
      { ...ok(), contentType: "application/octet-stream" },
    ]) {
      const s = setup();
      s.request.mockResolvedValue(response);
      await expect(s.fetch(input())).rejects.toHaveProperty("code");
    }
  });
  it("includes DNS in the total deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetch = createPublicFetch({ resolve: () => new Promise(() => {}) });
      const pending = fetch(input());
      const assertion = expect(pending).rejects.toHaveProperty(
        "code",
        "deadline_exceeded",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  it("aborts while waiting for DNS", async () => {
    const c = new AbortController();
    const fetch: PublicFetch = createPublicFetch({
      resolve: () => new Promise(() => {}),
    });
    const pending = fetch(input(undefined, { signal: c.signal }));
    c.abort();
    await expect(pending).rejects.toHaveProperty("code", "aborted");
  });
});

describe("document response and redirect edge cases", () => {
  it.each([
    "https://0x08080808/",
    "//0x08080808/",
    "https://store.example\\@elsewhere.example/",
  ])("rejects ambiguous redirect spelling %s", async (location) => {
    const s = setup();
    s.request.mockResolvedValue({
      ...ok(),
      status: 302,
      location,
    } as ReturnType<typeof ok>);
    await expect(s.fetch(input())).rejects.toHaveProperty(
      "code",
      "invalid_url",
    );
    expect(s.request).toHaveBeenCalledTimes(1);
  });
  it("rejects a product redirect to www even on the same apex", async () => {
    const s = setup();
    s.request.mockResolvedValue({
      ...ok(),
      status: 302,
      location: "https://www.store.example/p",
    } as ReturnType<typeof ok>);
    await expect(
      s.fetch(
        input("https://store.example/p", {
          kind: "product",
          lockedOrigin: "https://store.example",
        }),
      ),
    ).rejects.toHaveProperty("code", "origin_mismatch");
    expect(s.request).toHaveBeenCalledTimes(1);
  });
  it("rejects mixed-private DNS on the redirect without dialing it", async () => {
    const s = setup();
    s.request.mockResolvedValueOnce({
      ...ok(),
      status: 302,
      location: "/a",
    } as ReturnType<typeof ok>);
    s.resolve
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(s.fetch(input())).rejects.toHaveProperty(
      "code",
      "unsafe_address",
    );
    expect(s.request).toHaveBeenCalledTimes(1);
  });
  it.each(["robots", "discovery"] as const)(
    "caps plain %s at one MiB",
    async (kind) => {
      const s = setup();
      s.request.mockResolvedValue({
        ...ok(),
        contentType: "text/plain",
        body: ["x".repeat(1024 * 1024 + 1)],
      });
      await expect(s.fetch(input(undefined, { kind }))).rejects.toHaveProperty(
        "code",
        "body_too_large",
      );
    },
  );
  it("rejects empty DNS answers", async () => {
    const s = setup([]);
    await expect(s.fetch(input())).rejects.toHaveProperty(
      "code",
      "unsafe_address",
    );
    expect(s.request).not.toHaveBeenCalled();
  });
  it("uses a single deadline across redirects", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      s.request.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 6000));
        return { ...ok(), status: 302, location: "/next" };
      });
      const assertion = expect(s.fetch(input())).rejects.toHaveProperty(
        "code",
        "deadline_exceeded",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

it.each([404, 429, 503])(
  "returns HTTP %s metadata without reading unsupported bodies",
  async (status) => {
    const cancel = vi.fn();
    let consumed = false;
    const fetch = createPublicFetch({
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      now: () => new Date("2026-09-06T00:00:00Z"),
      request: async () => ({
        status,
        contentType: "",
        retryAfter: "120",
        body: {
          async *[Symbol.asyncIterator]() {
            consumed = true;
            yield "ignored";
          },
        },
        cancel,
      }),
    });
    const doc = await fetch(input());
    expect(doc).toMatchObject({ status, text: "", retryAfterSeconds: 120 });
    expect(consumed).toBe(false);
    expect(cancel).toHaveBeenCalled();
  },
);

it.each(["172800", "Tue, 08 Sep 2026 00:00:00 GMT"])(
  "preserves long Retry-After %s without retrying early",
  async (retryAfter) => {
    const fetch = createPublicFetch({
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      now: () => new Date("2026-09-06T00:00:00Z"),
      request: async () => ({ ...ok(), status: 429, retryAfter }),
    });
    expect((await fetch(input())).retryAfterSeconds).toBe(172800);
  },
);

it("refuses a robots-disallowed product redirect before the target request", async () => {
  const request = vi.fn(async () => ({
    status: 302,
    contentType: "text/html",
    location: "/private/one",
    body: [],
  }));
  const fetch = createPublicFetch({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request,
  });
  await expect(
    fetch(
      input("https://store.example/products/one", {
        kind: "product",
        lockedOrigin: "https://store.example/",
        approveUrl: (url: string) =>
          !new URL(url).pathname.startsWith("/private"),
      }),
    ),
  ).rejects.toHaveProperty("code", "robots_disallowed");
  expect(request).toHaveBeenCalledTimes(1);
});
it("returns initial canonical redirect evidence without fetching the unapproved host", async () => {
  const request = vi.fn(async () => ({
    status: 301,
    contentType: "text/html",
    location: "https://www.store.example/",
    body: [],
  }));
  const resolve = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
  const fetch = createPublicFetch({ resolve, request });
  const result = await fetch(input("https://store.example/"));
  expect(result).toMatchObject({
    url: "https://store.example/",
    redirectedTo: "https://www.store.example/",
    status: 301,
    text: "",
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(resolve).toHaveBeenCalledTimes(1);
});
