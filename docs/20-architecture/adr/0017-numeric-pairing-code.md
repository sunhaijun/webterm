# ADR-0017 Numeric pairing code: two keys per pairing, typeable when you can't scan

Status: Accepted (2026-09-12). Extends the pairing flow in [auth-pairing.md](../../60-security/auth-pairing.md); cookies, device management and rate limiting are unchanged.

## Context

The pairing code is 32 bytes from `crypto/rand`, base64url-encoded (43 characters), carried in the URL fragment and delivered to the phone through an ASCII QR code in the terminal. That works when the phone can scan the server's terminal. A common case is that it can't: **the user is on the phone, and the terminal is on another screen or another computer** (a remote session, screen sharing, a text-only chat window). Nobody can type 43 base64 characters, so users paste the URL into a chat app. That is exactly what T2 tries to avoid: the pairing code then lives in the chat history forever.

## Decision

1. **Each pairing issues two keys**: the URL code (unchanged: 32 bytes of entropy, fragment + QR code) and a **16-digit decimal code** (about 53 bits of entropy). Both are hashed into the same `pairings` row (`code_hash`, `digits_hash`), and **using either one invalidates the whole row**. Single use, a 5-minute TTL and constant-time comparison hold for both keys.
2. **Display grouping**: the terminal prints `1234-5678-9012-3456` (4-4-4-4, separated by `-`). Typed input accepts `-` and spaces and strips every other character.
3. **Entry point**: `/pair` without a fragment no longer says "no pairing code in the link". It shows a numeric input (`inputmode=numeric`, auto-grouping, submittable only at 16 digits) that posts to the same `POST /auth/pair`. The QR path is unchanged.
4. **The digit code does not replace the URL code.** There's no reason to lower entropy on the QR path. The digits only give the can't-scan case a path that doesn't go through a chat app.

Why 16 digits is enough: the threat is online guessing, not offline cracking (the database holds only hashes, and even those are deleted after 5 minutes). The existing rate limits (AC-1.6) are 5 attempts per IP per minute, exponential backoff up to 5 minutes after consecutive failures, and **a global breaker that trips for 10 minutes after 50 failures in an hour**. So during a code's 5-minute life, the whole internet gets at most 50 guesses: a hit probability of 50 / 10¹⁶ = 5 × 10⁻¹⁵. Pushing that to 10⁻⁶ would take 200 million consecutive pairing codes. That's enough, and the breaker prints a warning to stdout, so a person would notice.

Anything shorter doesn't work. With 8 digits the same 50 guesses give 5 × 10⁻⁷, and since an attacker can wait while the user opens code after code, that is no longer negligible. 16 digits is where "still bearable to type" (four groups of four, as long as a card number) meets "entropy no longer worth discussing".

## Consequences

- The `pairings` table gains a column (migration 0002); `CreatePairing` gains a parameter.
- Three more lines of terminal output. stdout already shows the full URL code, so the digits add no new exposure.
- The pairing page gains a form, replacing the "no pairing code in the link" message, which gave users no way forward anyway.
- Docs: [auth-pairing.md](../../60-security/auth-pairing.md) (flow, manual digit entry), [threat-model.md](../../60-security/threat-model.md) (T1 entropy), [acceptance-criteria.md](../../10-requirements/acceptance-criteria.md) (AC-1.4, new AC-1.15), [e2e-scenarios.md](../../70-testing/e2e-scenarios.md) (E2E-27), [install.md](../../80-ops/install.md) (pairing instructions).
- Code: `internal/store` (migration 0002, `CreatePairing` / `ConsumePairing`), `internal/auth` (`NewPairingCodes`, `FormatDigits`, `NormalizeCode`), `cmd/webterm` (`printPairing`), `web/src/ui/pair.tsx` + `paircode.ts`, copy in `gate.tsx`.
- Tests: UT-pair-5, IT-pair-4, vitest `paircode.test.ts`, E2E-27.
