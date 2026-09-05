# Website catalog import execution results

## Task 0 — protected Node document transport

Implemented in the existing `codex/website-catalog-import` worktree from `b651d45`. No merchant URL, production configuration, schema, provider, or deployment was used.

### Baseline

Before production source changes, `corepack.cmd pnpm@11.7.0 test`, `typecheck`, and `build` all exited 0. The test gate reported 67 root tests plus 1,694 package tests (1,761 total); Turbo reused its valid pre-change package cache. Build completed successfully. The current local `main` ref was `792c0ec13a837fed9c426b414674baeedacf2a65`; the implementation worktree remained on the requested base/branch with initially clean status.

A later `--force` follow-up overlapped intentionally missing-module RED tests and then in-progress source typing, so it is not a clean baseline. It reported those expected web failures and a Windows Turbo shim tail error. The final normal test command succeeded. Full raw logs remain under `.superpowers/sdd/website-*.log` locally.

### Verification

- Unit RED: missing `./public-fetch` module before implementation.
- Integration RED: same expected missing module, using the explicit root integration configuration.
- Additional RED: three raw redirect spelling cases; three non-2xx metadata cases; two long Retry-After cases. Each failed on the specific missing behavior before its fix.
- Final focused unit gate: 57 tests passing.
- Isolated actual TLS integration gate: 6 tests passing, including preserved Host/SNI, original-host certificate verification, one-resolution address pinning, ambient proxy independence, and socket cancellation for oversize/deadline/caller abort.
- Full repository test gate: 67 root tests plus 1,749 package tests (1,816 total), 14/14 Turbo tasks successful. This run contained the first 55 transport tests; the subsequent two Retry-After regressions and one-branch fix were verified by the final 57-test focused gate.
- Web typecheck: passing after implementation and the final Retry-After adjustment.
- Browser reproduction of the unchanged import page is owned by the controller and recorded separately. No production deployment compatibility is claimed by these local tests.

Commands use `corepack.cmd pnpm@11.7.0`, with this worktree's `node_modules/.task9-services/bin` prepended to PATH for nested pnpm. Unit tests never source synthetic browser-auth environment values.

### Contract for following tasks

`createPublicFetch()` returns `PublicFetch`. It accepts `url`, `kind` (`robots`, `discovery`, or `product`), `lockedOrigin`, and an AbortSignal. `PublicDocument` returns normalized final URL, status, MIME type, plain response text, capture timestamp, and nullable Retry-After seconds. Non-2xx responses return empty text and status metadata so orchestration can handle robots 404, 429, and 503. Long valid Retry-After values are preserved; orchestration must not shorten them.

The request factory supports injected resolver, request adapter, TLS dialer, and clock for deterministic tests. Default production requests use direct fresh Node HTTPS agents and explicit TLS certificate verification against the original hostname. There is no production private-network switch. The synthetic TLS test alone maps the pinned public address onto a loopback fixture and trusts its generated one-day certificate.

The user agent is `WukongCatalogPreview/1.0`. Identity encoding is requested; other successful-response encodings are rejected. HTML/XHTML is limited to 2 MiB, robots and XML/plain discovery documents to 1 MiB. Every document has one 10-second deadline covering DNS, redirects, connection, and body; redirects are limited to three. Fragment removal preserves query parameters. Only initial apex/www canonicalization can change origin; a supplied locked origin and product redirects cannot change it.

The durable scan layer owns the one-second interval, five discovery-document budget, 20-product limit, robots policy, workspace authorization, leases, persistence, and auditing. This transport only fetches one bounded document. A timed-out OS DNS lookup may finish in the background, but its result cannot initiate a connection after cancellation.

Errors are bounded to `invalid_url`, `unsafe_address`, `origin_mismatch`, `too_many_redirects`, `invalid_redirect`, `unsupported_content_type`, `unsupported_encoding`, `body_too_large`, `deadline_exceeded`, `aborted`, and `transport_failed`; raw network details are not returned.

The root integration config now includes only `apps/web/lib/website/**/*.integration.test.ts` in addition to its existing patterns. The web unit script already excludes all `*.integration.test.ts`. TLS integration tests require local OpenSSL to create ephemeral synthetic certificates; Git for Windows OpenSSL and Linux `openssl` are supported.
