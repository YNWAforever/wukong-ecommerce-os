// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AssignmentPanel } from "./assignment-panel";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(() => {
  act(() => root.render(null));
  vi.unstubAllGlobals();
});
const ids: [string, string] = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
];
function snapshot(role = "reviewer") {
  return {
    assignments: ids.map((listingId, index) => ({
      listingId,
      assigneeUserId: null,
      assignmentRevision: index + 3,
      assigneeActive: false,
      assigneeEmail: null,
    })),
    members: [
      { userId: "actor", name: null, email: "actor@local.invalid", role },
      {
        userId: "reviewer",
        name: null,
        email: "reviewer@local.invalid",
        role: "reviewer",
      },
    ],
    actorId: "actor",
    role,
  };
}
it("sends per-item revisions and reports partial failure without a complete-success message", async () => {
  const requests: Array<{ url: string; body?: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options) => {
      requests.push({ url, body: options?.body });
      return new Response(
        JSON.stringify(
          options?.method === "POST"
            ? {
                results: [
                  {
                    listingId: ids[0],
                    outcome: "assigned",
                    assigneeUserId: "actor",
                    assignmentRevision: 4,
                    replayed: false,
                  },
                  {
                    listingId: ids[1],
                    outcome: "revision_conflict",
                    assigneeUserId: "reviewer",
                    assignmentRevision: 9,
                    replayed: false,
                  },
                ],
                assigned: 1,
                failed: 1,
              }
            : snapshot(),
        ),
        { status: 200 },
      );
    }),
  );
  await act(async () =>
    root.render(<AssignmentPanel listingIds={ids} locale="en" />),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="assign-selected"]')!
      .click(),
  );
  const payload = JSON.parse(requests.find((r) => r.body)?.body ?? "{}");
  expect(payload.items.map((i: any) => i.expectedRevision)).toEqual([3, 4]);
  expect(new Set(payload.items.map((i: any) => i.idempotencyKey)).size).toBe(2);
  expect(container.textContent).toContain("1 assigned");
  expect(container.textContent).toContain("1 failed");
  expect(container.textContent).toContain("Changed by another teammate");
});
it("operator sees claim and reviewer handoff but cannot assign arbitrary users", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(snapshot("operator")))),
  );
  await act(async () =>
    root.render(<AssignmentPanel listingIds={ids} locale="en" />),
  );
  expect(container.querySelector('[data-testid="assign-selected"]')).toBeNull();
  expect(
    container.querySelector('[data-testid="claim-selected"]'),
  ).not.toBeNull();
  const options = Array.from(container.querySelectorAll("select option")).map(
    (o) => o.getAttribute("value"),
  );
  expect(options).not.toContain("actor");
  expect(options).toContain("reviewer");
});
it("rejects incomplete mutation receipts and keeps the selected work visible", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (_url, options) =>
        new Response(
          JSON.stringify(
            options?.method === "POST"
              ? { results: [], assigned: 2, failed: 0 }
              : snapshot(),
          ),
        ),
    ),
  );
  await act(async () =>
    root.render(<AssignmentPanel listingIds={ids} locale="en" />),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="assign-selected"]')!
      .click(),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not update assignments",
  );
  expect(container.textContent).not.toContain("2 assigned");
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function selectedSnapshot(
  listingId: string,
  currentRole = "operator",
  actorId = "new-actor",
) {
  return {
    ...snapshot(currentRole),
    actorId,
    assignments: [
      {
        listingId,
        assigneeUserId: null,
        assignmentRevision: 7,
        assigneeActive: false,
        assigneeEmail: null,
      },
    ],
  };
}
function assignedReceipt(
  listingId: string,
  assigneeUserId = "actor",
  revision = 4,
) {
  return new Response(
    JSON.stringify({
      results: [
        {
          listingId,
          outcome: "assigned",
          assigneeUserId,
          assignmentRevision: revision,
          replayed: false,
        },
      ],
      assigned: 1,
      failed: 0,
    }),
  );
}
it("keeps the new selection and current role when an accepted old POST finishes", async () => {
  const oldPost = deferred<Response>();
  const oldUpdated = vi.fn(),
    currentUpdated = vi.fn();
  const posts: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options?: RequestInit) => {
      if (options?.method === "POST") {
        posts.push(options);
        return posts.length === 1
          ? oldPost.promise
          : assignedReceipt(ids[1], "new-actor", 8);
      }
      return new Response(
        JSON.stringify(
          String(url).includes(ids[0])
            ? selectedSnapshot(ids[0], "reviewer", "actor")
            : selectedSnapshot(ids[1]),
        ),
      );
    }),
  );
  await act(async () =>
    root.render(
      <AssignmentPanel
        listingIds={[ids[0]]}
        locale="en"
        onUpdated={oldUpdated}
      />,
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="assign-selected"]')!
      .click(),
  );
  await act(async () =>
    root.render(
      <AssignmentPanel
        listingIds={[ids[1]]}
        locale="en"
        onUpdated={currentUpdated}
      />,
    ),
  );
  expect(posts[0]!.signal).toBeUndefined();
  expect(
    container.querySelector<HTMLButtonElement>('[data-testid="claim-selected"]')
      ?.disabled,
  ).toBe(false);
  await act(async () => oldPost.resolve(assignedReceipt(ids[0])));
  expect(container.textContent).not.toContain(ids[0]);
  expect(container.textContent).not.toContain("1 assigned");
  expect(container.querySelector('[data-testid="assign-selected"]')).toBeNull();
  expect(oldUpdated).not.toHaveBeenCalled();
  expect(currentUpdated).toHaveBeenCalledOnce();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="claim-selected"]')!
      .click(),
  );
  expect(JSON.parse(String(posts[1]!.body)).items[0]).toMatchObject({
    listingId: ids[1],
    action: "claim",
    assigneeUserId: "new-actor",
    expectedRevision: 7,
  });
  expect(container.textContent).toContain("1 assigned");
});
it("a stale failed POST cannot show its error or release a newer pending mutation", async () => {
  const oldPost = deferred<Response>(),
    newPost = deferred<Response>();
  let postCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options?: RequestInit) => {
      if (options?.method === "POST")
        return ++postCount === 1 ? oldPost.promise : newPost.promise;
      return new Response(
        JSON.stringify(
          String(url).includes(ids[0])
            ? selectedSnapshot(ids[0], "reviewer", "actor")
            : selectedSnapshot(ids[1]),
        ),
      );
    }),
  );
  await act(async () =>
    root.render(<AssignmentPanel listingIds={[ids[0]]} locale="en" />),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="assign-selected"]')!
      .click(),
  );
  await act(async () =>
    root.render(<AssignmentPanel listingIds={[ids[1]]} locale="en" />),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="claim-selected"]')!
      .click(),
  );
  expect(postCount).toBe(2);
  await act(async () =>
    oldPost.resolve(
      new Response(
        JSON.stringify({ requestId: "00000000-0000-4000-8000-000000000099" }),
        { status: 403 },
      ),
    ),
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(
    container.querySelector<HTMLButtonElement>('[data-testid="claim-selected"]')
      ?.disabled,
  ).toBe(true);
  await act(async () =>
    newPost.resolve(assignedReceipt(ids[1], "new-actor", 8)),
  );
  expect(
    container.querySelector<HTMLButtonElement>('[data-testid="claim-selected"]')
      ?.disabled,
  ).toBe(false);
  expect(container.textContent).toContain("1 assigned");
  expect(container.textContent).not.toContain(ids[0]);
});
it("does not update a remounted role scope or notify the retired parent", async () => {
  const oldPost = deferred<Response>();
  const retiredUpdated = vi.fn(),
    currentUpdated = vi.fn();
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options?: RequestInit) => {
      if (options?.method === "POST") return oldPost.promise;
      return new Response(
        JSON.stringify(
          selectedSnapshot(
            ids[0],
            ++reads === 1 ? "reviewer" : "viewer",
            reads === 1 ? "actor" : "new-actor",
          ),
        ),
      );
    }),
  );
  await act(async () =>
    root.render(
      <AssignmentPanel
        listingIds={[ids[0]]}
        locale="en"
        onUpdated={retiredUpdated}
      />,
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="assign-selected"]')!
      .click(),
  );
  act(() => root.render(null));
  await act(async () =>
    root.render(
      <AssignmentPanel
        listingIds={[ids[0]]}
        locale="en"
        onUpdated={currentUpdated}
      />,
    ),
  );
  await act(async () => oldPost.resolve(assignedReceipt(ids[0])));
  expect(retiredUpdated).not.toHaveBeenCalled();
  expect(currentUpdated).not.toHaveBeenCalled();
  expect(container.textContent).toContain(
    "Viewer access cannot claim or assign work",
  );
  expect(container.textContent).not.toContain("1 assigned");
});
it("keeps the latest read when GET responses finish in reverse order", async () => {
  const oldRead = deferred<Response>(),
    newRead = deferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn((url) =>
      String(url).includes(ids[0]) ? oldRead.promise : newRead.promise,
    ),
  );
  await act(async () =>
    root.render(<AssignmentPanel listingIds={[ids[0]]} locale="en" />),
  );
  await act(async () =>
    root.render(<AssignmentPanel listingIds={[ids[1]]} locale="en" />),
  );
  await act(async () =>
    newRead.resolve(
      new Response(JSON.stringify(selectedSnapshot(ids[1], "viewer"))),
    ),
  );
  await act(async () =>
    oldRead.resolve(
      new Response(
        JSON.stringify(selectedSnapshot(ids[0], "reviewer", "actor")),
      ),
    ),
  );
  expect(container.textContent).not.toContain(ids[0]);
  expect(container.textContent).toContain(ids[1]);
  expect(container.textContent).toContain(
    "Viewer access cannot claim or assign work",
  );
});

it.each([200, 403])(
  "reports current assignment layout completion after success or failure (%s)",
  async (status) => {
    const read = deferred<Response>();
    const settled = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => read.promise),
    );
    await act(async () =>
      root.render(
        <AssignmentPanel
          listingIds={[ids[0]]}
          locale="en"
          onSettled={settled}
        />,
      ),
    );
    expect(settled).not.toHaveBeenCalled();
    await act(async () =>
      read.resolve(
        Response.json(status === 200 ? selectedSnapshot(ids[0]) : {}, {
          status,
        }),
      ),
    );
    expect(settled).toHaveBeenCalledExactlyOnceWith(ids[0]);
    expect(container.textContent).not.toContain("Loading assignments");
  },
);

it("never reports retired selection or unmounted assignment reads as settled", async () => {
  const oldRead = deferred<Response>(),
    newRead = deferred<Response>();
  const settled = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(newRead.promise),
  );
  await act(async () =>
    root.render(
      <AssignmentPanel listingIds={[ids[0]]} locale="en" onSettled={settled} />,
    ),
  );
  await act(async () =>
    root.render(
      <AssignmentPanel listingIds={[ids[1]]} locale="en" onSettled={settled} />,
    ),
  );
  await act(async () =>
    oldRead.resolve(Response.json(selectedSnapshot(ids[0]))),
  );
  expect(settled).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  await act(async () =>
    newRead.resolve(Response.json(selectedSnapshot(ids[1]))),
  );
  expect(settled).not.toHaveBeenCalled();
});

it("reports the static selection limit layout without starting an assignment read", async () => {
  const settled = vi.fn(),
    fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const selection = Array.from(
    { length: 101 },
    (_, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  );
  await act(async () =>
    root.render(
      <AssignmentPanel
        listingIds={selection}
        locale="en"
        onSettled={settled}
      />,
    ),
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Assign up to 100 listings");
  expect(settled).toHaveBeenCalledExactlyOnceWith(
    [...selection].sort().join(","),
  );
});
