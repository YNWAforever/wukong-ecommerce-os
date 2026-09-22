# Jev listing verification operations

Jev listing verification is an optional server-side advisory. It is disabled unless TYPESAFE_VERIFICATION_MODE=advisory; absence means off. Advisory results do not replace deterministic compliance flags, workspace authorization, review transitions, or delivery eligibility.

| Variable                   | Source                                                                        |
| -------------------------- | ----------------------------------------------------------------------------- |
| TYPESAFE_API_KEY           | User-provided TypeSafe account API credential, stored only as a server secret |
| TYPESAFE_MODEL             | Explicit documented pinned model, initially jev-1.13.0 after verification     |
| TYPESAFE_VERIFICATION_MODE | Operator off/advisory selection; absent means off                             |

The verification operation has a five-second total timeout and no automatic retries. Provider failure produces an unavailable result while the normal listing workflow continues. Cost may be null when provider usage or pricing cannot establish it. Only text evidence is sent; images, audio, video, binaries, credentials, signed URLs, prompts, and raw provider responses are excluded from logs and provider state.

Treat stored verification versions as stale when the evidence, questions, thresholds, or pinned model changes. Existing batch budgets count only known observed costs; unknown costs are excluded rather than guessed. A local observed-cost cap is an operational guard, not a hard provider billing guarantee.

Apply the database migration and complete preview validation before activation. Production migration, deployment, paid evaluation, and activation each require separate production authorization.

To roll back, set TYPESAFE_VERIFICATION_MODE=off and render/deploy the configuration. TYPESAFE_API_KEY may remain installed while off, so rollback does not require deleting the secret. Off mode cannot issue provider calls. Work already in flight when the mode changes may complete under the configuration it read; confirm the queue has drained if an immediate operational boundary is required.
