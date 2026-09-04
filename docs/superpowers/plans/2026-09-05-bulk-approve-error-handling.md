# Bulk-Approve Error Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `apps/web/components/queue-client.tsx`'s `runBulkApprove` so a network failure or non-2xx response is visibly reported to the operator instead of failing silently or crashing the render.

**Architecture:** One file, one new state variable (`bulkError`), a rewritten `runBulkApprove`, and one new render block — no backend change.

**Tech Stack:** React 19, Vitest + `happy-dom`, plain `react-dom` test-utils (no React Testing Library in this codebase).

---

**Live-code discipline:** every file:line reference below was verified against the live checkout during this session's design/research pass (2026-09-05), on `main`. Even so, **read the current file before editing it** — treat quoted code as a starting point to diff against, not a guarantee.

**Environment:** pnpm is not reliably on PATH — use `corepack pnpm` for every command.

**Testing convention (confirmed real in `queue-client.test.tsx`):** `// @vitest-environment happy-dom` pragma; `act`/`createElement` from `react`; `createRoot`/`Root` from `react-dom/client`; a local `mount(fetcher)`/`unmount(root)` helper pair; a `findButtonByText(container, text)` helper. The existing bulk-approve test uses a URL-dispatching fetch mock: `vi.fn<typeof fetch>().mockImplementation((input, init) => { const url = ...; calls.push({ url, init }); if (url === "/api/listings/bulk-approve") { return Promise.resolve(...); } return Promise.resolve(Response.json({ items: [...] })); })` — every new test should follow this same dispatching pattern, not a simpler single-URL mock, since the component fetches `/api/listings` on mount before the bulk-approve action ever runs.

---

## Task 1: Fix `runBulkApprove`'s error handling

**Files:**

- Modify: `apps/web/components/queue-client.tsx`
- Modify: `apps/web/components/queue-client.test.tsx`

- [ ] **Step 1: Read the current files**

Read `apps/web/components/queue-client.tsx` in full and confirm it still matches:

```tsx
const [items, setItems] = useState<ListingCollectionItem[] | null>(null);
const [error, setError] = useState<string | null>(null);
const [selected, setSelected] = useState<Set<string>>(new Set());
const [bulkResult, setBulkResult] = useState<BulkApproveResponse | null>(null);
const [bulkPending, setBulkPending] = useState(false);
```

```tsx
const runBulkApprove = async () => {
  setBulkPending(true);
  setBulkResult(null);
  try {
    const response = await fetch("/api/listings/bulk-approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listingIds: [...selected] }),
    });
    const body = (await response.json()) as BulkApproveResponse;
    setBulkResult(body);
    setSelected(new Set());
    load();
  } finally {
    setBulkPending(false);
  }
};
```

```tsx
{
  bulkResult ? (
    <ul className="bulk-result-list" aria-live="polite">
      {bulkResult.results.map((result) =>
        result.ok ? (
          <li key={result.listingId}>✓ {result.listingId}</li>
        ) : (
          <li key={result.listingId}>
            ✗ {result.listingId}: {result.message}
          </li>
        ),
      )}
    </ul>
  ) : null;
}
```

Confirm the top-level `error` state (lines 93-98: `if (error) return <p className="inline-warning" role="alert">{error}</p>;`) is a different concept — the queue itself failed to load, and returns early replacing the whole component. The new `bulkError` must **not** reuse this variable or this early-return pattern, since the queue view stays valid when only the bulk-approve action fails.

Read `apps/web/components/queue-client.test.tsx` in full and confirm the existing bulk-approve test ("selects eligible items and runs bulk-approve, then reloads the list", around lines 135-181) still matches the URL-dispatching fetcher pattern described above.

- [ ] **Step 2: Write the failing tests**

Add these two tests to the `describe("QueueClient", ...)` block, immediately after the existing "selects eligible items and runs bulk-approve, then reloads the list" test:

```tsx
it("shows a visible error and preserves the selection when bulk-approve's request fails outright", async () => {
  const calls: { url: string }[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url });
    if (url === "/api/listings/bulk-approve") {
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    return Promise.resolve(Response.json({ items: [eligibleItem] }));
  });

  const { container, root } = await mount(fetcher);

  await act(async () => {
    findButtonByText(container, "全選可批准項目")!.click();
    await Promise.resolve();
  });

  await act(async () => {
    findButtonByText(container, "批准")!.click();
    await Promise.resolve();
  });

  const alert = container.querySelector('[role="alert"]');
  expect(alert).not.toBeNull();
  expect(alert!.textContent).toContain("Bulk approve failed");

  // Selection is preserved -- the bulk-action-bar only renders while
  // selected.size > 0, and it must still be there after a failed attempt.
  expect(container.querySelector(".bulk-action-bar")).not.toBeNull();
  expect(container.textContent).toContain("1 個項目已選取");

  // The list was not reloaded -- only the one initial /api/listings call.
  const listingsCalls = calls.filter((call) => call.url === "/api/listings");
  expect(listingsCalls.length).toBe(1);

  await unmount(root);
});

it("shows the server's error message and does not render the results list when bulk-approve returns a non-ok response", async () => {
  const calls: { url: string }[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url });
    if (url === "/api/listings/bulk-approve") {
      return Promise.resolve(
        Response.json(
          {
            code: "insufficient_role",
            message: "Reviewer access is required.",
          },
          { status: 403 },
        ),
      );
    }
    return Promise.resolve(Response.json({ items: [eligibleItem] }));
  });

  const { container, root } = await mount(fetcher);

  await act(async () => {
    findButtonByText(container, "全選可批准項目")!.click();
    await Promise.resolve();
  });

  await act(async () => {
    findButtonByText(container, "批准")!.click();
    await Promise.resolve();
  });

  const alert = container.querySelector('[role="alert"]');
  expect(alert).not.toBeNull();
  expect(alert!.textContent).toContain("Reviewer access is required.");

  expect(container.querySelector(".bulk-result-list")).toBeNull();
  expect(container.querySelector(".bulk-action-bar")).not.toBeNull();

  const listingsCalls = calls.filter((call) => call.url === "/api/listings");
  expect(listingsCalls.length).toBe(1);

  await unmount(root);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `corepack pnpm exec vitest run apps/web/components/queue-client.test.tsx`
Expected: both new tests FAIL. The first fails because the rejected fetch is currently uncaught (the test's `act()` call will surface an unhandled rejection or the alert assertion will find nothing, since `bulkError` doesn't exist yet). The second fails because `bulkResult` is set to the raw `{code, message}` error body, and `bulkResult.results.map(...)` throws on `undefined` — surfacing as a thrown error during render inside `act()`, not a clean assertion failure. Confirm every pre-existing test in this file still passes.

- [ ] **Step 4: Implement the fix**

Change the state declarations from:

```tsx
const [bulkResult, setBulkResult] = useState<BulkApproveResponse | null>(null);
const [bulkPending, setBulkPending] = useState(false);
```

to:

```tsx
const [bulkResult, setBulkResult] = useState<BulkApproveResponse | null>(null);
const [bulkError, setBulkError] = useState<string | null>(null);
const [bulkPending, setBulkPending] = useState(false);
```

Change `runBulkApprove` from:

```tsx
const runBulkApprove = async () => {
  setBulkPending(true);
  setBulkResult(null);
  try {
    const response = await fetch("/api/listings/bulk-approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listingIds: [...selected] }),
    });
    const body = (await response.json()) as BulkApproveResponse;
    setBulkResult(body);
    setSelected(new Set());
    load();
  } finally {
    setBulkPending(false);
  }
};
```

to:

```tsx
const runBulkApprove = async () => {
  setBulkPending(true);
  setBulkResult(null);
  setBulkError(null);
  try {
    const response = await fetch("/api/listings/bulk-approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listingIds: [...selected] }),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      setBulkError(bulkErrorMessage(body));
      return;
    }
    setBulkResult(body as BulkApproveResponse);
    setSelected(new Set());
    load();
  } catch {
    // Covers both a rejected fetch() call (network failure) and a thrown
    // response.json() (malformed body) -- both reach this same fallback,
    // since neither has a real server-reported message to show instead.
    setBulkError("Bulk approve failed -- try again.");
  } finally {
    setBulkPending(false);
  }
};
```

Add this helper function above `QueueClient` (after the existing `BulkApproveResponse` type, before the component):

```tsx
function bulkErrorMessage(body: unknown): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof (body as { message: unknown }).message === "string"
  ) {
    return (body as { message: string }).message;
  }
  return "Bulk approve failed -- try again.";
}
```

Change the render block from:

```tsx
{
  bulkResult ? (
    <ul className="bulk-result-list" aria-live="polite">
      {bulkResult.results.map((result) =>
        result.ok ? (
          <li key={result.listingId}>✓ {result.listingId}</li>
        ) : (
          <li key={result.listingId}>
            ✗ {result.listingId}: {result.message}
          </li>
        ),
      )}
    </ul>
  ) : null;
}
```

to:

```tsx
{
  bulkError ? (
    <p className="inline-warning" role="alert">
      {bulkError}
    </p>
  ) : null;
}
{
  bulkResult ? (
    <ul className="bulk-result-list" aria-live="polite">
      {bulkResult.results.map((result) =>
        result.ok ? (
          <li key={result.listingId}>✓ {result.listingId}</li>
        ) : (
          <li key={result.listingId}>
            ✗ {result.listingId}: {result.message}
          </li>
        ),
      )}
    </ul>
  ) : null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `corepack pnpm exec vitest run apps/web/components/queue-client.test.tsx`
Expected: PASS, and confirm every pre-existing test in this file still passes (7 pre-existing + 2 new = 9 total).

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/queue-client.tsx apps/web/components/queue-client.test.tsx
git commit -m "fix: surface bulk-approve request failures instead of failing silently"
```

(Add a `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.)

---

## Task 2: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the test file**

```bash
corepack pnpm exec vitest run apps/web/components/queue-client.test.tsx
```

Expected: PASS, zero failures.

- [ ] **Step 2: Typecheck**

```bash
corepack pnpm --filter @wukong/web typecheck
```

Expected: exit 0, clean.

- [ ] **Step 3: Format check**

```bash
node scripts/check-runtime-format.mjs
```

If either touched file is listed, run `corepack pnpm exec prettier --write <file>` on it and commit that separately as a small `style:` follow-up commit.

- [ ] **Step 4: Report status**

Do not push or open a pull request — stop here and report back with the full verification checklist's results (Steps 1-3), matching how every prior package/fix this session was handed back for the user's own review/merge.
