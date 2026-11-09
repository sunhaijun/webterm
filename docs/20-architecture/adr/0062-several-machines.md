# ADR-0062 Several machines in one page

Status: Accepted (2026-11-08). Amends [ADR-0048](0048-sign-out.md) §1 (`Clear-Site-Data` without `"cookies"`) and widens the `Origin` rule of AC-1.8 from "the service domain" to "the service domain or the origin the device was paired from". Adds US-10 and AC-10. The WebSocket protocol is unchanged.

## Context

One person, several servers in different countries, each running its own agent with its own domain, certificate and devices. Today each is a separate site: one home-screen icon per machine, and switching means leaving one PWA for another. Linking from one to the next doesn't help: an installed PWA that navigates to another origin leaves its own window (iOS opens an in-app browser sheet, Android a custom tab).

What was considered and rejected:

- **A hub that relays to the others** (the others dial out to it, the browser talks only to the hub). One origin and one pairing, but every keystroke takes an extra hop, the hub is a single point of failure, and it holds the keys to every machine. The goal is the opposite: get the list from one place, then talk to each machine directly.
- **Direct connections across sites with bearer tokens.** Servers on unrelated domains or bare IP addresses are cross-site to each other: a `SameSite=Strict` cookie is never sent, and Safari blocks third-party cookies anyway. Tokens would have to live in `localStorage`, readable by any script, which gives up `HttpOnly` (threat model T3) for every machine at once.

The fact the design rests on: **`SameSite` compares sites, not origins**. A site is the scheme plus the registrable domain (eTLD+1, from the Public Suffix List); neither the subdomain nor the port is part of it. `https://tokyo.example.com:8443` and `https://la.example.com:8443` are different origins on the same site. A page from one can open a WebSocket or `fetch` with credentials to the other, and the browser sends **the other machine's own** `SameSite=Strict`, `HttpOnly` cookie. Nothing about the cookie changes; the agents only have to accept a second origin, precisely.

## Decision

### 1. A machine is an origin on the page's site

A machine is the origin of its agent: scheme, host and port (`https://la.example.com:8443`). Machines that share one page must be on the same site as that page: one subdomain each of one registrable domain. Consequences, all stated where they apply:

- **IP mode can't take part** ([ADR-0044](0044-ip-address-certificates.md)): an IP address is a site of its own.
- **One host name per machine.** Cookies ignore ports, so two agents behind one host name on different ports would overwrite each other's `webterm_session`.
- A domain on the Public Suffix List (dynamic DNS such as duckdns.org) makes every subdomain its own site, so it can't be used.

### 2. The list lives in the browser

The page keeps the machines in `localStorage`: `webterm.machines` (an array of origins, the page's own excluded) and `webterm.machine` (the current one). These are addresses, not secrets. The page's own machine is always first and can't be removed.

The agents don't know about each other: there is no agent-to-agent connection, no shared state and nothing central. Each machine's device list, pairing and revocation stay exactly its own.

### 3. Adding a machine

On the machine to add, `webterm pair` (over SSH) prints the usual code. In the page: Machines → Add machine, an address and the 16 digits ([ADR-0017](0017-numeric-pairing-code.md)). The address is normalized before anything is sent:

- `la.example.com`, `la.example.com:8443`, `https://la.example.com:8443` and `https://la.example.com:8443/pair` are all accepted; only scheme, host and port are kept (the agent serves only `/`).
- The scheme is the page's; another explicit scheme is refused.
- **No port means the page's port**: machines usually share one port (8443 when something else holds 443), and a page on 443 gets 443.
- The host is lowercased, a trailing dot dropped, a default port left out.
- An IP address is refused, and so is a host whose last two labels differ from the page's: the registrable domain always includes the last two labels, so such a host is certainly another site. The agent decides the remaining cases (§4).
- The page's own origin or one already in the list is refused.

The page then sends `POST <origin>/auth/pair` with `credentials: 'include'`. The agent answers as for any pairing, and its `Set-Cookie` lands in the browser's jar for that host: a response to a same-site request is first-party. In an installed iOS PWA, whose cookie jar is not Safari's, this is the only way to pair it with another machine: scanning a QR code would open Safari instead. On success the machine is added and becomes current.

### 4. A device is bound to the origin it was paired from

`devices` gains a column `origin`. `POST /auth/pair` looks at the request's `Origin`:

| `Origin` | Result | `devices.origin` |
|---|---|---|
| none (curl, tests) or the agent's own | paired | empty |
| same site as the agent, another origin | paired | that origin |
| anything else | `403 cross_site`, the code is not consumed | — |

**Every authenticated request that carries an `Origin` header** must come from the agent's own origin or the device's `origin`; anything else is `403 forbidden` (logged, like the existing WebSocket rejection). This covers the WebSocket upgrade, writes and reads alike. Reads join the rule because of §5: CORS answers any same-site origin, so without it any page on the same domain could read `/api/fs/list` with your cookie. Requests without `Origin` (same-origin `GET`s, `<img>`, `<video>`) are unchanged.

A device paired on the agent's own page has no `origin` and works only there, as before. `GET /api/devices` and `webterm devices` show `origin` when it is set, so a device paired from another machine's page can be told apart.

### 5. CORS: who may read an answer

For a request whose `Origin` is on the agent's site (its own included; under `--dev`, any local origin), every response under `/auth/` and `/api/` carries `Access-Control-Allow-Origin: <that origin>`, `Access-Control-Allow-Credentials: true` and `Vary: Origin` — refusals included, so the page can tell "pairing required" (`401`) from "unreachable". A preflight (`OPTIONS`) under `/auth/` or `/api/` from such an origin gets `204` with `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE`, `Access-Control-Allow-Headers: Content-Type, Range` and `Access-Control-Max-Age: 600`. A preflight from any other origin gets `403` without CORS headers, so the browser never sends the request.

CORS only says who may **read** an answer; §4 says who may **act**. A same-site page that isn't the device's origin reads only the `403`.

### 6. CSP

The page's CSP lets it reach the other machines on its site, on any port: `connect-src` adds `https://*.<site>:* wss://*.<site>:* https://<site>:* wss://<site>:*`, and `img-src` and `media-src` add the `https` ones (the file browser previews another machine's images and video). A source without `:*` would match only port 443. In IP mode the CSP is unchanged. Under `--dev` the same lists use `http://*.localhost:*` and `ws://*.localhost:*`.

### 7. One machine at a time

The page talks to one machine: switching closes the WebSocket to the current machine and opens one to the chosen one, and sessions, terminals, the file browser and uploads are all that machine's. The app is rebuilt for the chosen machine, as on a page load: its sessions come back through the snapshot path. Text-page drafts are kept per machine while the page lives, so switching away and back doesn't lose one. Theme, font size and the other device preferences are the device's and stay as they are.

The page opens on the machine used last. If that is another machine and it can't be reached or answers `401`, the page falls back to its own machine. Once the page is open (its shell comes from the service worker's cache) the machine that served it is not needed: you can switch among the others while it is down.

### 8. Where you switch

- **compact**: the session drawer's title becomes a button with the current machine's name and a chevron (`machine-button`); it opens the Machines sheet over the drawer.
- **wide**: the same button at the left end of the tab bar.
- **Machines sheet** (`machines-sheet`): one row per machine, the page's own first, then in the order added; the name, and `host:port` as the meta; the current one marked. A tap switches and closes the sheets. Swipe left or long-press (as session rows, [ADR-0039](0039-drawer-row-swipe-actions.md)) reveals Remove, not on the own machine. The foot is one button, Add machine.
- **Add sheet** (`machine-add`): the address and the code (`inputmode=numeric`, grouped by four as on the pairing page), Cancel and Add; Add is enabled with an address and 16 digits. A failure leaves both fields and shows why in one line.

A machine's name is the first label of its host (`la`); when two machines share it, both show the full host.

### 9. Signed out of a machine

When the current machine is another one and it answers `401` (at the gate or on a later probe), the page switches to its own machine and opens the Add sheet with that address filled in and the reason: "This device was revoked on la" (`code: "revoked"`) or "Pairing required on la". The page's own machine answering `401` behaves as before: the pairing page.

### 10. Removing a machine

Remove sends `POST <origin>/auth/logout`: the agent revokes the device and clears its cookie. `204` or `401` means done and the machine leaves the list. If the request can't get through, a confirmation asks "Can't reach la. Remove it anyway?" with the line "It stays signed in there", because the token is still valid on that server and only that server can revoke it (`webterm devices revoke`). Removing the current machine switches to the page's own machine first.

### 11. Sign out this device means every machine

"Sign out this device" ([ADR-0048](0048-sign-out.md)) is the device leaving, not one machine. The page signs out of each other machine first, as Remove does but without asking, then of its own as before. If its own machine can't be reached it refuses, as before. The signed-out page then lists the machines that couldn't be reached: "Still signed in on la.example.com:8443".

### 12. `Clear-Site-Data` without cookies

`POST /auth/logout` no longer sends `"cookies"` in `Clear-Site-Data`. That directive clears every cookie of the **registrable domain**, not of the origin: signing out of one machine would drop the cookies of all its sibling machines from the browser, leaving their tokens valid on the servers with no device holding them, and would also sign the user out of unrelated services on the same domain. The cookie is cleared by `Set-Cookie` with `Max-Age=0` for this host, as it already was. `"storage", "cache"` are sent only when the request comes from the agent's own origin (or has no `Origin`): a sign-out from another machine's page must not ask the browser to clear storage it doesn't use. Under `--dev` every local origin counts as the agent's own, so there "own" also means the origin's host and port are the request's. This amends ADR-0048 §1.

### 13. Different versions

The page comes from one machine and may talk to an agent of another version. The WebSocket already says so in `hello.protocol`. Over HTTP, an agent older than this ADR answers no preflight, and the page sees only a failed request. When adding fails that way, the page probes `<origin>/healthz` with `mode: 'no-cors'`: if that gets through, it says "la.example.com:8443 refused this page" (troubleshooting: an older webterm, or not the same site); otherwise "Can't reach la.example.com:8443".

### 14. Development and tests

Under `--dev`, local origins also include `*.localhost` (and the CSP lists of §6 use them). Chromium resolves every `*.localhost` to the loopback address and treats it as a secure context, and the site of `a.test.localhost` is `test.localhost`, so two dev agents at `a.test.localhost` and `b.test.localhost` are two same-site machines, as in production. E2E-56 uses them; the origin binding of §4 is covered by Go tests with a production configuration, because under `--dev` every local origin counts as the agent's own.

### 15. Not now

- "Waiting for you" from the machines you aren't looking at: it needs a connection to each of them. A later step.
- Machines on IP addresses, and several agents behind one host name (§1).

## Consequences

- One installed PWA, one pairing per machine, one tap to switch; the connection goes straight to the machine, and no machine depends on another.
- The machine that serves the page runs the code that drives every machine the device added there: if it is compromised, so are they, the next time the page is opened. That is inherent in one page for several machines; it adds no network path. The origin binding keeps the damage to that one page: other subdomains, and pages the device didn't pair from, can't act on a machine.
- A page elsewhere on the same domain was already same-site with webterm and can still embed `/api/fs/raw` in an `<img>` (no `Origin`, cookie sent); it can't read the pixels. Keep untrusted content off the domain the machines live on.
- Every device pairs with every machine once, from the page (16 digits).
- A domain is required for this; machines on bare IPs stay separate.
- Signing out no longer clears cookies of other services on the same domain.
