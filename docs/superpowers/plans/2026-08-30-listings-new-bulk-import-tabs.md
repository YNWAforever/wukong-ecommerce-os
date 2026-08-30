# Listings-New Bulk Import Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `/listings/new` into three tabs (Existing products / Supporting evidence / New products) so the already-working `POST /api/listings/import` Bulk Update endpoint finally has a UI, matching the approved design at `docs/superpowers/specs/2026-08-30-listings-new-bulk-import-tabs-design.md`.

**Architecture:** Four new small components (`ListingIntakeTabs`, `BulkImportPanel`, `SupportingEvidencePanel`, `NewProductBlockedPanel`) plus a small CSS addition for the tab pattern (currently unstyled anywhere in the codebase) and a one-line swap in `page.tsx`. `BulkImportPanel` separates pure, dependency-injected logic (`validateBulkImportFile`, `submitBulkImport`) from its thin React wrapper, matching the existing `createListingDraft`/`ListingIntakeClient` pattern in this codebase exactly. No backend changes — `POST /api/listings/import` is untouched and already tested.

**Tech Stack:** Next.js 16 App Router, React 19, plain CSS, Vitest, `happy-dom` test environment, `react-dom/server`/`react-dom/client` for component tests (this codebase does not use `@testing-library/react`).

**Environment note:** `pnpm` is not on a normal PATH in this environment. Every `Run:` command below must be preceded by (or combined with) this PATH prefix in the same PowerShell invocation:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
```

---

## File Map

```text
apps/web/components/
  bulk-import-panel.tsx          Pure logic (validateBulkImportFile, submitBulkImport) + BulkImportPanel component
  bulk-import-panel.test.ts      Pure-logic tests + one DOM-mounted success-path test
  supporting-evidence-panel.tsx  Static placeholder panel
  supporting-evidence-panel.test.tsx
  new-product-blocked-panel.tsx  Static blocked-explanation panel
  new-product-blocked-panel.test.tsx
  listing-intake-tabs.tsx        Tab switcher, mirrors admin-tabs.tsx's ARIA pattern exactly
  listing-intake-tabs.test.tsx

apps/web/app/globals.css          Modify: add .admin-tab-list/.admin-tab/.admin-tab-panel rules
apps/web/app/(app)/listings/new/page.tsx   Modify: render ListingIntakeTabs instead of ListingIntakeClient
```

---

### Task 1: Bulk import pure logic

**Files:**

- Create: `apps/web/components/bulk-import-panel.tsx`
- Test: `apps/web/components/bulk-import-panel.test.ts`

**Interfaces:**

- Consumes: nothing new — calls the existing `POST /api/listings/import` (`apps/web/app/api/listings/import/route.ts`, unchanged).
- Produces: `MAX_BULK_IMPORT_BYTES`, `validateBulkImportFile`, `submitBulkImport`, `BulkImportOutcome` and its member types.

- [ ] **Step 1: Write the failing tests for `validateBulkImportFile`**

```ts
// apps/web/components/bulk-import-panel.test.ts
import { describe, expect, it, vi } from "vitest";

import {
  MAX_BULK_IMPORT_BYTES,
  submitBulkImport,
  validateBulkImportFile,
} from "./bulk-import-panel.js";

function xlsxFile(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

describe("validateBulkImportFile", () => {
  it("rejects a file that is not .xlsx", () => {
    const file = xlsxFile("catalog.csv", 100);
    expect(validateBulkImportFile(file)).toBe(
      "Choose an .xlsx SHOPLINE Bulk Update workbook.",
    );
  });

  it("rejects a file over the 4 MiB runtime limit", () => {
    const file = xlsxFile("catalog.xlsx", MAX_BULK_IMPORT_BYTES + 1);
    expect(validateBulkImportFile(file)).toBe(
      "Workbook exceeds the 4 MiB runtime limit.",
    );
  });

  it("accepts a valid .xlsx file within the size limit", () => {
    const file = xlsxFile("catalog.xlsx", 1024);
    expect(validateBulkImportFile(file)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail because the module doesn't exist**

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- bulk-import-panel.test.ts
```

Expected: FAIL — `Cannot find module './bulk-import-panel.js'` (or equivalent resolution error).

- [ ] **Step 3: Implement `MAX_BULK_IMPORT_BYTES` and `validateBulkImportFile`**

```tsx
// apps/web/components/bulk-import-panel.tsx
"use client";

import { useState } from "react";

/** Matches MAX_UPLOAD_BYTES in apps/web/app/api/listings/import/route.ts:34. */
export const MAX_BULK_IMPORT_BYTES = 4 * 1024 * 1024;

export function validateBulkImportFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    return "Choose an .xlsx SHOPLINE Bulk Update workbook.";
  }
  if (file.size > MAX_BULK_IMPORT_BYTES) {
    return "Workbook exceeds the 4 MiB runtime limit.";
  }
  return null;
}
```

- [ ] **Step 4: Run the tests and verify the three pass**

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- bulk-import-panel.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing tests for `submitBulkImport`'s validation short-circuit and network error**

Add to `apps/web/components/bulk-import-panel.test.ts`:

```ts
describe("submitBulkImport", () => {
  it("returns a validation_error without calling the fetcher for a bad extension", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await submitBulkImport(xlsxFile("catalog.csv", 100), {
      fetcher,
    });
    expect(result).toEqual({
      kind: "validation_error",
      message: "Choose an .xlsx SHOPLINE Bulk Update workbook.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a validation_error without calling the fetcher for an oversized file", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await submitBulkImport(
      xlsxFile("catalog.xlsx", MAX_BULK_IMPORT_BYTES + 1),
      { fetcher },
    );
    expect(result).toEqual({
      kind: "validation_error",
      message: "Workbook exceeds the 4 MiB runtime limit.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a network_error when the fetcher throws", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await submitBulkImport(xlsxFile("catalog.xlsx", 100), {
      fetcher,
    });
    expect(result).toEqual({
      kind: "network_error",
      message: "Could not reach the server. Try again.",
    });
  });

  it("returns a success outcome with the real response fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          specVersion: "opak-2026-05",
          parsedRows: 2,
          createdDrafts: 2,
          refreshedProducts: 0,
          issues: [
            {
              code: "quantity_negative",
              severity: "warning",
              row: 3,
              column: "quantity",
              value: "-1",
              message: "Stock cannot be negative; clamped to 0.",
            },
          ],
        },
        { status: 201 },
      ),
    );
    const result = await submitBulkImport(xlsxFile("catalog.xlsx", 100), {
      fetcher,
    });
    expect(result).toEqual({
      kind: "success",
      specVersion: "opak-2026-05",
      parsedRows: 2,
      createdDrafts: 2,
      refreshedProducts: 0,
      issues: [
        {
          code: "quantity_negative",
          severity: "warning",
          row: 3,
          column: "quantity",
          value: "-1",
          message: "Stock cannot be negative; clamped to 0.",
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/listings/import",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([
    ["empty_upload", "Attach a SHOPLINE bulk update form."],
    ["upload_too_large", "The bulk update form is too large."],
    ["upload_not_a_workbook", "The upload is not a readable xlsx workbook."],
    [
      "bulk_form_unreadable",
      "No product rows could be read from this bulk update form.",
    ],
    [
      "bulk_form_too_many_rows",
      "This form holds too many products for one import.",
    ],
    [
      "shopline_connection_missing",
      "Connect a SHOPLINE store before importing a catalog.",
    ],
    ["insufficient_role", "Operator access is required."],
  ])("maps API error code %s to its message", async (code, message) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ code, message: "server detail" }, { status: 400 }),
      );
    const result = await submitBulkImport(xlsxFile("catalog.xlsx", 100), {
      fetcher,
    });
    expect(result).toEqual({ kind: "api_error", code, message });
  });
});
```

- [ ] **Step 6: Run the tests and verify they fail for the expected reason**

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- bulk-import-panel.test.ts
```

Expected: FAIL — `submitBulkImport is not a function` / `Cannot find export`.

- [ ] **Step 7: Implement `submitBulkImport` and its supporting types**

Add to `apps/web/components/bulk-import-panel.tsx`, above the existing `validateBulkImportFile`:

```ts
export type BulkImportIssue = {
  code: string;
  severity: "error" | "warning";
  row: number | null;
  column: string | null;
  value: string | null;
  message: string;
};

export type BulkImportSuccess = {
  kind: "success";
  specVersion: string;
  parsedRows: number;
  createdDrafts: number;
  refreshedProducts: number;
  issues: BulkImportIssue[];
};

export type BulkImportFailure =
  | { kind: "validation_error"; message: string }
  | { kind: "api_error"; code: string; message: string }
  | { kind: "network_error"; message: string };

export type BulkImportOutcome = BulkImportSuccess | BulkImportFailure;

export type BulkImportDeps = { fetcher: typeof fetch };

const API_ERROR_MESSAGES: Record<string, string> = {
  empty_upload: "Attach a SHOPLINE bulk update form.",
  upload_too_large: "The bulk update form is too large.",
  upload_not_a_workbook: "The upload is not a readable xlsx workbook.",
  bulk_form_unreadable:
    "No product rows could be read from this bulk update form.",
  bulk_form_too_many_rows: "This form holds too many products for one import.",
  shopline_connection_missing:
    "Connect a SHOPLINE store before importing a catalog.",
  insufficient_role: "Operator access is required.",
};
```

Then insert this function after `validateBulkImportFile`:

```ts
export async function submitBulkImport(
  file: File,
  deps: BulkImportDeps = { fetcher: fetch },
): Promise<BulkImportOutcome> {
  const validationError = validateBulkImportFile(file);
  if (validationError) {
    return { kind: "validation_error", message: validationError };
  }

  let response: Response;
  try {
    response = await deps.fetcher("/api/listings/import", {
      method: "POST",
      body: file,
    });
  } catch {
    return {
      kind: "network_error",
      message: "Could not reach the server. Try again.",
    };
  }

  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof body.code === "string" ? body.code : "unknown_error";
    const message =
      API_ERROR_MESSAGES[code] ??
      (typeof body.message === "string" ? body.message : "The import failed.");
    return { kind: "api_error", code, message };
  }

  return {
    kind: "success",
    specVersion: body.specVersion as string,
    parsedRows: body.parsedRows as number,
    createdDrafts: body.createdDrafts as number,
    refreshedProducts: body.refreshedProducts as number,
    issues: (body.issues as BulkImportIssue[]) ?? [],
  };
}
```

- [ ] **Step 8: Run the tests and verify all pass**

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- bulk-import-panel.test.ts
```

Expected: PASS (14 tests: 3 from Step 4 + 2 validation-shortcut + 1 network-error + 1 success + 7 error-code cases; all green, no failures).

- [ ] **Step 9: Commit**

```bash
git add apps/web/components/bulk-import-panel.tsx apps/web/components/bulk-import-panel.test.ts
git commit -m "feat: add bulk import validation and submit logic"
```

---

### Task 2: `BulkImportPanel` component

**Files:**

- Modify: `apps/web/components/bulk-import-panel.tsx`
- Modify: `apps/web/components/bulk-import-panel.test.ts`

**Interfaces:**

- Consumes: `submitBulkImport` from Task 1 (same file).
- Produces: `BulkImportPanel` (React component, default export not used — named export, matching `ListingIntakeClient`'s convention).

- [ ] **Step 1: Write the failing DOM-mounted test**

Add to the top of `apps/web/components/bulk-import-panel.test.ts`, above the existing `describe` blocks:

```ts
// @vitest-environment happy-dom
```

This must be the very first line of the file (a Vitest environment pragma), so move the existing `import` lines below it.

Add these two imports to the existing import block at the top of the file (alongside the Task 1 imports), and add `BulkImportPanel` to the existing `import { MAX_BULK_IMPORT_BYTES, submitBulkImport, validateBulkImportFile } from "./bulk-import-panel.js";` line:

```ts
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
```

Then add at the end of the file:

```ts
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("BulkImportPanel", () => {
  it("renders the real parsed/created/refreshed counts after a successful import", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          specVersion: "opak-2026-05",
          parsedRows: 2,
          createdDrafts: 2,
          refreshedProducts: 0,
          issues: [],
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(BulkImportPanel));
    });

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    Object.defineProperty(input!, "files", {
      configurable: true,
      value: [xlsxFile("catalog.xlsx", 100)],
    });
    await act(async () => {
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // submitBulkImport awaits one fetch + one .json() call, so flush once more.
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("2");

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails because `BulkImportPanel` doesn't exist**

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- bulk-import-panel.test.ts
```

Expected: FAIL — `BulkImportPanel is not exported` / `undefined is not a function`.

- [ ] **Step 3: Implement `BulkImportPanel`**

Append to the end of `apps/web/components/bulk-import-panel.tsx`:

```tsx
export function BulkImportPanel() {
  const [outcome, setOutcome] = useState<BulkImportOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setOutcome(null);
    const result = await submitBulkImport(file);
    setOutcome(result);
    setBusy(false);
  }

  return (
    <div className="intake-form">
      <div className="upload-dropzone">
        <label htmlFor="bulk-import-file" className="upload-label">
          <span className="upload-title">匯入 SHOPLINE Bulk Update 匯出檔</span>
          <span className="upload-subtitle">
            上載最新匯出的 .xlsx 檔案 · 最多 4 MiB
          </span>
          <span className="secondary-button upload-button">
            選擇檔案 <span>Select file</span>
          </span>
        </label>
        <input
          id="bulk-import-file"
          type="file"
          accept=".xlsx"
          disabled={busy}
          onChange={handleChange}
        />
      </div>

      {outcome?.kind === "success" ? (
        <ul className="file-list" aria-live="polite">
          <li>
            已解析 {outcome.parsedRows} 列 · 新增 {outcome.createdDrafts} 筆草稿
            · 更新 {outcome.refreshedProducts} 筆
          </li>
          {outcome.issues.map((issue, index) => (
            <li key={index}>{issue.message}</li>
          ))}
        </ul>
      ) : null}

      <p className="intake-message" role="status" aria-live="polite">
        {busy
          ? "匯入中…"
          : outcome && outcome.kind !== "success"
            ? outcome.message
            : "選擇最新的 SHOPLINE Bulk Update 匯出檔開始匯入。"}
      </p>
    </div>
  );
}
```

`useState` is already imported at the top of the file from Task 1's `"use client"` header.

- [ ] **Step 4: Run the test and verify it passes**

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- bulk-import-panel.test.ts
```

Expected: PASS (15 tests total: 14 from Task 1 + this new success-render test).

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/bulk-import-panel.tsx apps/web/components/bulk-import-panel.test.ts
git commit -m "feat: add BulkImportPanel component"
```

---

### Task 3: `SupportingEvidencePanel`

**Files:**

- Create: `apps/web/components/supporting-evidence-panel.tsx`
- Test: `apps/web/components/supporting-evidence-panel.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/components/supporting-evidence-panel.test.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SupportingEvidencePanel } from "./supporting-evidence-panel";

describe("SupportingEvidencePanel", () => {
  it("renders an explanation with no interactive form controls", () => {
    const markup = renderToStaticMarkup(<SupportingEvidencePanel />);
    expect(markup).toContain("Supporting evidence");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<form");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- supporting-evidence-panel.test.tsx
```

Expected: FAIL — `Cannot find module './supporting-evidence-panel'`.

- [ ] **Step 3: Implement `SupportingEvidencePanel`**

```tsx
// apps/web/components/supporting-evidence-panel.tsx
export function SupportingEvidencePanel() {
  return (
    <div className="intake-form">
      <h2>補充證據 Supporting evidence</h2>
      <p>
        此功能在本試點階段尚未提供。此頁面不會接受或儲存任何檔案。
        <br />
        This capability is not yet available in this pilot. This page does not
        accept or store any file.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Run the test and verify it passes**

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- supporting-evidence-panel.test.tsx
```

Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/supporting-evidence-panel.tsx apps/web/components/supporting-evidence-panel.test.tsx
git commit -m "feat: add SupportingEvidencePanel placeholder"
```

---

### Task 4: `NewProductBlockedPanel`

**Files:**

- Create: `apps/web/components/new-product-blocked-panel.tsx`
- Test: `apps/web/components/new-product-blocked-panel.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/components/new-product-blocked-panel.test.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NewProductBlockedPanel } from "./new-product-blocked-panel";

describe("NewProductBlockedPanel", () => {
  it("renders a blocked explanation with no interactive form controls", () => {
    const markup = renderToStaticMarkup(<NewProductBlockedPanel />);
    expect(markup).toContain("blocked");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<form");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- new-product-blocked-panel.test.tsx
```

Expected: FAIL — `Cannot find module './new-product-blocked-panel'`.

- [ ] **Step 3: Implement `NewProductBlockedPanel`**

```tsx
// apps/web/components/new-product-blocked-panel.tsx
export function NewProductBlockedPanel() {
  return (
    <div className="intake-form">
      <h2>新商品（已阻擋） New products (blocked)</h2>
      <p>
        真實的 Opak SHOPLINE Bulk Update
        匯出檔沒有商品代碼、完整商品描述或圖片欄位，並以現有商品編號為鍵值，不能用作建立新商品。
        <br />
        The real Opak SHOPLINE Bulk Update export has no product handle, full
        product description, or images column, and is keyed by an existing
        Product ID — it cannot be used to create new products.
      </p>
      <p>
        新商品建立為獨立、另行驗證的流程，本頁面不會提供。
        <br />
        New product creation is a separate, independently-validated flow and is
        not offered from this page.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Run the test and verify it passes**

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- new-product-blocked-panel.test.tsx
```

Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/new-product-blocked-panel.tsx apps/web/components/new-product-blocked-panel.test.tsx
git commit -m "feat: add NewProductBlockedPanel"
```

---

### Task 5: `ListingIntakeTabs`

**Files:**

- Create: `apps/web/components/listing-intake-tabs.tsx`
- Test: `apps/web/components/listing-intake-tabs.test.tsx`

**Interfaces:**

- Consumes: `BulkImportPanel` (Task 2), `SupportingEvidencePanel` (Task 3), `NewProductBlockedPanel` (Task 4).
- Produces: `ListingIntakeTabs`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/components/listing-intake-tabs.test.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ListingIntakeTabs } from "./listing-intake-tabs";

describe("ListingIntakeTabs", () => {
  it("shows three tabs with Existing products selected by default", () => {
    const markup = renderToStaticMarkup(<ListingIntakeTabs />);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain("現有商品");
    expect(markup).toContain("補充證據");
    expect(markup).toContain("新商品");

    const buttonPattern = /<button[^>]*role="tab"[^>]*>[^<]*<\/button>/g;
    const buttons = markup.match(buttonPattern) ?? [];
    expect(buttons).toHaveLength(3);

    const selectedButtons = buttons.filter((button) =>
      button.includes('aria-selected="true"'),
    );
    expect(selectedButtons).toHaveLength(1);
    expect(selectedButtons[0]).toContain("現有商品");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- listing-intake-tabs.test.tsx
```

Expected: FAIL — `Cannot find module './listing-intake-tabs'`.

- [ ] **Step 3: Implement `ListingIntakeTabs`**

```tsx
// apps/web/components/listing-intake-tabs.tsx
"use client";

import { useState } from "react";

import { BulkImportPanel } from "./bulk-import-panel";
import { NewProductBlockedPanel } from "./new-product-blocked-panel";
import { SupportingEvidencePanel } from "./supporting-evidence-panel";

type IntakeTab = "bulk" | "evidence" | "create";

const TABS: { id: IntakeTab; label: string }[] = [
  { id: "bulk", label: "現有商品 Existing products" },
  { id: "evidence", label: "補充證據 Supporting evidence" },
  { id: "create", label: "新商品 New products" },
];

export function ListingIntakeTabs() {
  const [active, setActive] = useState<IntakeTab>("bulk");

  return (
    <div className="admin-tabs">
      <div className="admin-tab-list" role="tablist" aria-label="商品匯入區段">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            id={`intake-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            aria-controls="intake-tab-panel"
            className={active === tab.id ? "admin-tab active" : "admin-tab"}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id="intake-tab-panel"
        className="admin-tab-panel"
        role="tabpanel"
        aria-labelledby={`intake-tab-${active}`}
      >
        {active === "bulk" ? <BulkImportPanel /> : null}
        {active === "evidence" ? <SupportingEvidencePanel /> : null}
        {active === "create" ? <NewProductBlockedPanel /> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test and verify it passes**

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- listing-intake-tabs.test.tsx
```

Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/listing-intake-tabs.tsx apps/web/components/listing-intake-tabs.test.tsx
git commit -m "feat: add ListingIntakeTabs"
```

---

### Task 6: Style the tab pattern

**Files:**

- Modify: `apps/web/app/globals.css`

No test — this is a pure CSS addition with no behavior to assert; `listing-intake-tabs.test.tsx` and `admin-tabs.test.tsx` already assert the correct classes/ARIA structure exist. Visual correctness is confirmed manually (Step 2 below) and via the visual-regression scope named in the parent integration plan (§14), not by a unit test.

- [ ] **Step 1: Add the tab CSS rules**

Append to the end of `apps/web/app/globals.css`:

```css
.admin-tabs {
  display: grid;
  gap: 20px;
}
.admin-tab-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px;
  background: var(--stone);
  border-radius: var(--radius);
}
.admin-tab {
  min-height: 44px;
  padding: 8px 16px;
  color: var(--ink-soft);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  font-weight: 700;
  cursor: pointer;
}
.admin-tab.active {
  color: var(--navy);
  background: var(--surface);
  border-color: var(--line);
  box-shadow: 0 2px 8px rgb(24 36 50 / 6%);
}
```

This reuses the existing `--stone`, `--radius`, `--ink-soft`, `--navy`, `--surface`, `--line` tokens already defined at the top of this file (lines 1-16) — no new tokens are introduced. `--radius` is `12px`, matching the rest of the app; do not use the Site's `16px` literal, which belongs to an unrelated Tailwind default and would be visually inconsistent with every other card in this codebase.

- [ ] **Step 2: Visually confirm via the dev server**

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web dev
```

Navigate to `/listings/new` (requires a signed-in session per the local-development runbook) and to `/admin` (whose tabs were previously unstyled) and confirm both render a navy-on-stone segmented tab control with a white active tab. Stop the dev server afterward.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/globals.css
git commit -m "style: add tab list/tab/tab-panel rules shared by AdminTabs and ListingIntakeTabs"
```

---

### Task 7: Wire `/listings/new` to `ListingIntakeTabs`

**Files:**

- Modify: `apps/web/app/(app)/listings/new/page.tsx`

- [ ] **Step 1: Swap the rendered component**

In `apps/web/app/(app)/listings/new/page.tsx`, replace:

```tsx
import { ListingIntakeClient } from "../../../../components/listing-intake-client";
```

with:

```tsx
import { ListingIntakeTabs } from "../../../../components/listing-intake-tabs";
```

and replace the `<ListingIntakeClient />` usage near the end of the file with:

```tsx
<ListingIntakeTabs />
```

Leave every other line of the file (breadcrumb, page header, step indicator) unchanged — this is a one-component swap, not a rewrite of the page shell.

- [ ] **Step 2: Run the full web test suite to confirm nothing broke**

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test
```

Expected: PASS — all existing tests remain green, including `listing-intake-client.test.ts` (that component still compiles and passes its own tests even though `page.tsx` no longer imports it).

- [ ] **Step 3: Run typecheck and lint for the web package**

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web typecheck
pnpm --filter @wukong/web lint
```

Expected: both exit 0.

- [ ] **Step 4: Run the full monorepo test suite and typecheck as a final check**

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm test
pnpm typecheck
```

Expected: both exit 0 across every package, matching the 431-test/14-task baseline confirmed earlier this session, plus this plan's new tests.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(app)/listings/new/page.tsx"
git commit -m "feat: wire /listings/new to the new intake tabs"
```

---

## Self-Review

**1. Spec coverage:** Design doc §2 (architecture) → Tasks 1-5, 7. §3 (components) → Tasks 1-4. §4 (data flow) → Task 1's `submitBulkImport`. §5 (error handling) → Task 1's 7 error-code tests + network-error test. §6 (testing) → every task's test step. §7 (CSS) → Task 6. No spec section lacks a task.

**2. Placeholder scan:** no "TBD"/"add appropriate error handling"/unshown code — every step has complete, runnable code.

**3. Type consistency:** `BulkImportOutcome`/`BulkImportIssue`/`BulkImportDeps` defined once in Task 1, imported and used identically in Task 2's test and component. `ListingIntakeTabs`'s `IntakeTab` union (`"bulk" | "evidence" | "create"`) matches the three panel components it renders, defined once in Task 5, not redefined elsewhere.
