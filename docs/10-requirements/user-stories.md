# User stories

> Status: Accepted

A single-user tool; "I" is the one user. Each story is tagged with its milestone (see [`../90-roadmap/milestones.md`](../90-roadmap/milestones.md)).
Each story has acceptance criteria in [`acceptance-criteria.md`](acceptance-criteria.md).

---

## US-1 Deployment and access

**US-1.1** (m2) I copy one binary to a server, run it, and get a reachable service with a valid HTTPS certificate — no nginx, no manual certificate request, nothing to change beyond DNS.

**US-1.2** (m2) On first visit I see a QR code in the server terminal. Scanning it with my phone authorizes the phone, and it never has to log in again.

**US-1.3** (m2) I can see every authorized device, revoke any one of them (say, a lost phone), or revoke all of them at once.

**US-1.4** (m6) I can add webterm to my phone's home screen. It opens without the browser address bar, like a native app.

**US-1.5** (m11) I have no domain, or don't want to set up DNS for a throwaway server: the machine's public IP is enough to get a valid HTTPS certificate, and my phone can still scan the code and install the PWA ([ADR-0044](../20-architecture/adr/0044-ip-address-certificates.md)).

**US-1.6** (m11) On a new server I do exactly one thing outside the machine (open 80/443 in the cloud security group), then `scp` one binary and run `./webterm install`. The last thing I see is the pairing QR code. The server needs no GitHub credentials. If any step fails — especially the security group — I'm told **before** the service starts ([ADR-0045](../20-architecture/adr/0045-install-from-the-binary.md)).

**US-1.7** (m12) I run one command on a fresh server and the installer walks me through whatever it can't do itself: it tells me which DNS record or cloud firewall rule to add, waits while I do it, checks that it worked, and continues to the QR code — no restarting from scratch ([ADR-0046](../20-architecture/adr/0046-guided-install.md)).

**US-1.8** (m13) When I stop using a device, I sign it out from the device itself: the server no longer accepts it, and nothing left on it can get back in ([ADR-0048](../20-architecture/adr/0048-sign-out.md)).

**US-1.9** (m14) At a laptop with a real terminal, I `ssh` into the server and attach to any running session — the same sessions, names and order the browser shows — and pick it by name or number. Closing ssh leaves the session running ([ADR-0050](../20-architecture/adr/0050-ssh-attach.md)).

**US-1.10** (m19) I don't hand-edit claude's, codex's or my shell's config to get the most out of webterm: the installer offers to set them up, and `webterm setup --check` tells me any time what's missing ([ADR-0055](../20-architecture/adr/0055-webterm-setup.md)).

---

## US-2 Never lose the connection

**US-2.1** (m1/m3) My network drops for 20 seconds on the subway. When it comes back, the terminal **continues from where it was** — no redraw, no blank screen, no pressing Enter to refresh.

**US-2.2** (m1/m3) I was typing during the two seconds the network was down. After it recovers, **nothing I typed is lost**; all of it reaches the terminal in order.

**US-2.3** (m3) I close my laptop and open it two hours later. The session is still there, and so is the output of the build that finished in the meantime (after a reload or a long disconnect, the snapshot brings back the last 2000 lines).

**US-2.4** (m8) However long I was gone, or if I reloaded the page, I come back to the session's **current full screen** (including full-screen programs like vim and claude) and can scroll back through some history — not a screen of garbage, not a blank.

**US-2.5** (m3) I can always see the connection state: online / reconnecting / restored. On restore it tells me how much was caught up.

---

## US-3 Input

**US-3.1** (m8) I want to write a 300-character Chinese prompt for the AI agent running in the terminal. I flip the extra-keys area to the text page and write in a **normal text box**: the IME candidate window is in the right place, and I can edit and paste freely. One Enter sends the whole thing to the terminal and submits it.

**US-3.2** (m4) `:wq` in vim, arrow keys in htop, Ctrl+C to interrupt a command — I tap the terminal, type, and the keys pass straight through.

**US-3.3** (m8) There are no "modes" to understand: tap the terminal to type, tap again to hide the keyboard; for a long paragraph, tap ✎ to flip to the text page. The UI doesn't change when the foreground program changes.

**US-3.4** (m4) On a phone, the layout doesn't jump when the on-screen keyboard opens, and the keyboard doesn't cover the terminal content.

**US-3.5** (m8) On a phone I can press `Esc`, `Tab`, `Ctrl`, `Alt`, the arrow keys, `Home` `End` `PgUp` `PgDn`, and `/` `-` — keys the on-screen keyboard lacks or buries. They sit in two rows in fixed positions, like Termux, so I learn them after a few presses.

**US-3.6** (m4) Pasting multi-line text doesn't make the shell run each line as a separate command (bracketed paste).

**US-3.7** (m15) I show claude a screenshot or a photo from whatever device I'm on. On the phone I tap the paperclip on the text page and pick from the photo library or take a picture; on a laptop I paste the screenshot or drop the file on the terminal. It shows up in claude's prompt as `[Image #1]`, in the session I sent it from, and I write my question after it. Files other than images arrive as a path the program can read ([ADR-0051](../20-architecture/adr/0051-send-files-to-a-session.md)).

**US-3.8** (m18, m21, m22) The last column gives me what my phone makes slow: ↵ answers claude's prompts and pickers with the keyboard down (↑ ↓ ↵, ESC); in claude or codex, ⌘ is a two-row strip of that tool's commands and shortcuts, taken from the tool itself so they follow its upgrades, in the order I arranged by dragging them in a list ([ADR-0057](../20-architecture/adr/0057-command-strip-and-history.md), [ADR-0058](../20-architecture/adr/0058-enter-key-and-two-row-strip.md)).

**US-3.9** (m20) Reading a long answer on my phone, I swipe the extra keys away to the right and get four or five more rows; a small button in the corner (or a swipe left where the keys were) brings them back. Swiping across the keys never presses one by accident ([ADR-0056](../20-architecture/adr/0056-collapsible-extra-keys.md)).

---

## US-4 Multiple sessions

**US-4.1** (m6) I can run several sessions at once — one building, one tailing logs, one editing code — without them interfering.

**US-4.2** (m8) On a phone, switching sessions is: tap the session button, then tap a session. The button sits under my thumb and shows how many sessions are open. On desktop and tablet it's one tap on the tab bar.

**US-4.3** (m6, m16) Sessions I switch away from keep running in the background. When one of them is waiting for me (claude or codex finished its turn or asks for permission, a long build is done) I see a dot: on the session button on phones, on the tab on desktop and tablet. Output alone, like a spinner, doesn't light it, and looking at the session clears it on every device ([ADR-0052](../20-architecture/adr/0052-waiting-for-you-replaces-unread.md)).

**US-4.4** (m6) A session is automatically named after its current directory (e.g. `webterm`), not `Session 1/2/3`. I can also rename it by hand.

**US-4.5** (m6) When a session's shell exits, I can still see its last output; the tab doesn't just vanish.

**US-4.6** (m14) When one session is open on two devices of different sizes, the one I'm typing on has the right layout. Leaving the other one open doesn't take the size away from me ([ADR-0050](../20-architecture/adr/0050-ssh-attach.md) §5).

---

## US-5 Reading output

**US-5.1** (m3) I scroll back through output with a normal scroll gesture, without entering any "mode".

**US-5.3** (m8) By default there's nothing to tune: light/dark follows the system and the font size is a sensible default. If I want to change something, settings have exactly two options: theme (system / light / dark) and terminal font size ([ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md)).

**US-5.4** (m6) I can select and copy output text, and long selections aren't lost to auto-scroll.

**US-5.5** (m17) On my phone I tap a link claude printed and choose Open or Copy; on a laptop I Ctrl+click it. When I type `/copy` in claude, the answer is on my phone's clipboard ([ADR-0053](../20-architecture/adr/0053-links-and-clipboard.md)).

---

## US-7 Diagnosability

**US-7.2** (m2) When certificate issuance fails, the server terminal tells me why and how to fix it — not a raw Go error.

**US-7.3** (m6) When I hit the session limit I get a clear message, not a new-session button that does nothing.
