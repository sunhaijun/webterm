# Manual test checklist

> Status: Accepted · grows with the implementation

What automation can't test. **Run it by hand before every release**; don't release until every box is checked.

Automated coverage is in [`strategy.md`](strategy.md) and [`e2e-scenarios.md`](e2e-scenarios.md).

---

## CJK input (every time since m4)

Automation can only dispatch composition events; it can't test how a real IME's candidate window behaves.

- [ ] **iOS Pinyin**: write 100+ Chinese characters on the text page. Candidate window in place; editing mid-text and paste work; Enter sends and submits. In claude, a 300-character prompt submits with one Enter
- [x] **iOS Pinyin**: type Chinese in direct input (running `vim`); the inline preview follows the cursor
- [ ] **Android Gboard**: same two items as above
- [x] **macOS Pinyin / Microsoft Pinyin**: type Chinese in direct input on desktop; the preview follows the cursor
- [ ] Press `Enter` during composition to pick a candidate — **must not submit by mistake** (check once in direct input and once on the text page)
- [x] Use arrow keys during composition to move between candidates — the terminal must not eat them
- [x] Mixed Chinese and English: wide characters line up correctly in the terminal (`unicode11` addon active)
- [x] Paste multi-line text containing Chinese; it isn't executed line by line

## On-screen keyboard and layout (since m4 / m6)

- [ ] iOS Safari tab: the keyboard opens, the terminal shrinks, and both rows of extra keys sit on top of the keyboard, fully visible
- [ ] iOS PWA (added to home screen): same
- [ ] Android Chrome: same
- [ ] After the keyboard closes the layout recovers, with no leftover blank space
- [ ] Rotate portrait → landscape → portrait three times: layout and terminal size stay right, and **the form doesn't flip** (landscape phone keeps the session button + drawer; tablet with keyboard up keeps the tab bar)
- [ ] On devices with a notch / home indicator, nothing is covered (`safe-area-inset`)
- [ ] Tap the terminal: the keyboard alternately opens and closes; in programs with mouse tracking (`htop`, `vim` with `mouse=a`) a tap is a click and doesn't toggle the keyboard
- [ ] In tmux (`set -g mouse on`), drag to scroll pane history (enters copy-mode): scrolling starts as soon as the finger moves (tmux default: 1 row of drag = 5 lines); `q` exits. With claude run directly, dragging scrolls its conversation
- [ ] Pressing extra keys doesn't open or close the keyboard; tap `CTRL` then `c` on the keyboard = `^C`; long-press `CTRL` to lock it
- [ ] Switch to the text page with ✎ and back; terminal rows and columns don't change; swiping over the keys also switches
- [ ] Tablet: mid-composition on session A's text page (candidates still open), tap session B's tab → the partial text stays in A's draft, **never lands in B's textarea**, and isn't sent anywhere; switching back to A shows the draft
- [ ] Phone: the session button (shows the session count) opens the drawer; **the system back button closes the drawer, not the PWA**; picking a session with the keyboard up keeps the keyboard up
- [ ] iPhone with home indicator: `+ New session` and ⚙ in the drawer sit fully above the indicator, with a gap; with one session the drawer is about half the screen; the settings sheet also clears the indicator
- [ ] iOS / Android: ⚙ has the same stroke weight as `+` and ✎ and isn't rendered as a color emoji
- [ ] iOS / Android: swipe a drawer row left to reveal Pin / Rename / Close; scrolling the list doesn't open rows; the rename sheet sits fully above the keyboard
- [ ] Close a session running tmux or claude (try both the tab ✕ and swipe-to-close in the drawer) → no "Session not found" error appears
- [ ] Tablet / PC: switching tabs, renaming (double-click / long-press), closing, and creating with `+` all work; the terminal doesn't reflow on switch
- [ ] Tablet: open more tabs than fit; `+` stays visible right of the tab strip; tapping the current tab's ✕ and `+` never hits the other
- [ ] Tablet with an external keyboard → `Ctrl+Shift+*` shortcuts work

## Real networks (every time since m3) ★

The real test of the "never disconnects" promise; automation can only simulate it.

- [x] Wi-Fi → 4G: with `emit.sh` running, switch networks; the screen **keeps growing**, no redraw, no blank
- [x] Subway / elevator: lose signal for 30 seconds in a tunnel; it recovers on its own afterwards with complete content
- [ ] Airplane mode on for 2 minutes, then off: recovers (may redraw once via snapshot), screen complete, later output correct
- [ ] Close the laptop lid for 2 hours, then open it: the session is there and the current screen is complete (snapshot, up to 2000 lines of history)
- [ ] Type three commands in the terminal while offline → after recovery they run in order, none lost, none duplicated
- [x] On a weak network (throttled to 100kbps), scrolling and typing are still acceptable
- [ ] On a real network, see both the connection banner (reconnecting / offline) and "Resumed · caught up N KB" with sensible numbers; the terminal doesn't reflow when the banner comes and goes
- [ ] Refresh: claude / vim / htop / plain shell sessions look the same as before, and the plain shell scrolls back (2000 lines from the snapshot)
- [ ] Rotate (column count changes), then refresh: the screen matches what it was before (the agent's reflow wins)
- [ ] Long CJK output (lots of 。…—“”) loses no punctuation (regression for xterm dropping characters from split UTF-8)

## PWA (since m6)

- [x] iOS: add to home screen; icon correct, launches without an address bar
- [x] Android: install prompt appears; launches fine after install
- [x] Light/dark theme follows the system
- [ ] Force light / dark in settings: status bar, scrollbars, and terminal all switch together; reopening the PWA from the home screen doesn't flash the other background; switching back to System follows the system again
- [x] Start the PWA while offline → shows "Can't reach the agent", not a white screen, and doesn't pretend to work
- [x] After a new version is released, an old PWA prompts "Update available · Reload" and **doesn't reload on its own** (it must not interrupt sessions)

## Deployment (every time TLS / install changes, since m2)

- [x] `webterm doctor` gives a readable diagnosis when something is missing (test each: port 80 taken, DNS pointing elsewhere, no domain)
- [ ] On a first install, `doctor --acme` issues a production certificate; after the service starts the log says "Certificate ready" and there's no second issuance (only one certificate in `certs/`)
- [x] Production Let's Encrypt issuance succeeds
- [x] Pair a phone by scanning the QR code (the terminal QR code scans at the actual font size)
- [x] After `setcap`, a regular user can bind 443
- [x] `--https-port 8443`: the certificate is issued via HTTP-01 on port 80, the pairing QR code includes `:8443`, and scanning it on a phone opens the page
- [x] After `loginctl enable-linger`, the service keeps running when SSH exits
- [ ] System service (ADR-0034): `systemctl cat webterm` shows `User=` as yourself; `cat /proc/$(systemctl show webterm -p MainPID --value)/oom_score_adj` is -900; `cat /proc/self/oom_score_adj` in a session is 0; `systemctl --user status` works in a session
- [ ] Migrate from a user service: `webterm update --force-restart` run inside a webterm session is refused; run from SSH it succeeds, the user unit is gone, the system unit is active, and sessions inside tmux survive
- [ ] Memory pressure (needs root, disturbs the whole machine): run `stress-ng --vm 1 --vm-bytes 90%` in a webterm session → stress-ng is what gets killed; webterm and the other sessions survive
- [x] The service starts automatically after a server reboot
- [x] Replace the binary + `setcap` + restart → clients see the "The agent is restarting" notice and reconnect to the new version
- [x] Behind a reverse proxy (nginx), WebSocket works and doesn't drop every 60 seconds
- [ ] IP mode (ADR-0044): `./webterm install` (no `--domain`) on a cloud server issues a production IP certificate; scanning the code on a phone opens `https://<IP>` with no certificate warning in the address bar; it can be added to the home screen (one iOS and one Android device)
- [ ] IP certificate renewal: after the service has run for 5 days, the expiry in the `webterm` status overview has moved later and the log shows a successful renewal
- [ ] `webterm install` (ADR-0045): `scp` the binary up and install directly, with no `gh` and no `GH_TOKEN` on the server; the last screen of the install is the QR code
- [ ] Guided install (ADR-0046), port 80 blocked in the security group: the installer names the console page to open, waits; after opening the port, Enter re-checks and the install finishes with a QR code. Run without a terminal (`ssh server ./webterm install </dev/null`), it stops before writing a systemd unit
- [ ] Guided install with a domain whose `A` record doesn't exist yet: the installer shows the record to add and continues on its own once it resolves
- [ ] One-line install from a release: `curl -fsSL https://github.com/sunhaijun/webterm/releases/latest/download/install.sh | bash` on a fresh server asks for the address and ends with a QR code
- [ ] On a machine with ufw enabled: `sudo ufw status` shows 80/443 after the install
- [ ] Switch the same machine from IP to a domain: after `./webterm install --domain X`, both the `webterm` status overview and `webterm pair` use the new domain, **the open sessions survive** (hot upgrade with the new command line, ADR-0047 §1), and the browser connects at the new address without a manual restart
- [ ] Upgrade from v0.3.0 with a new `--https-port`: `reload` does two hot upgrades (the old agent can't take a command line), sessions survive, and the new port answers
- [ ] Install from the web (`gh api … | bash -s -- --channel dev`): the log shows "Handing over to webterm …" (the binary's bundled install script), and the installed version is the dev build

## SSH attach (every time attach or the size rules change, since m14)

- [ ] From a laptop terminal (iTerm2 / Windows Terminal / GNOME Terminal), `ssh -t server webterm attach` with several sessions lists them in the tab order; picking one draws its screen and history, and the laptop's scrollback holds that history once (no copy after resizing the window)
- [ ] The phone has the same session open: typing on the laptop gives the session the laptop's size; tapping and typing on the phone gives it back; the window you type in always has the right layout
- [ ] Run claude in the session from the laptop, then close the ssh window: the session keeps running, and the laptop terminal's title and modes (mouse, bracketed paste) are back to normal in the next ssh login
- [ ] `webterm update` on the server while attached: the attach redraws within seconds and keeps working

## Sending files (every time uploads or the text page change, since m15)

[ADR-0051](../20-architecture/adr/0051-send-files-to-a-session.md). Run claude (and codex if installed) in a session, some of it inside tmux.

- [ ] iPhone (Safari and the installed PWA): text page → paperclip → Photo Library → a photo → claude shows `[Image #1]`. Note whether the saved file is `.jpg` or `.heic`; a `.heic` path stays plain text in claude, and then the browser has to convert (ADR-0051 §2)
- [ ] iPhone: paperclip → Take Photo → `[Image #1]`; a full-resolution photo submitted with a question gets an answer about the photo (no size error from claude)
- [ ] iPhone: copy a screenshot (screenshot → Copy and Delete), long-press the text box → Paste → `[Image #1]`, nothing pasted into the box
- [ ] Android (Chrome and the PWA): paperclip → camera and gallery both give `[Image #1]`; pasting an image from the keyboard's clipboard into the text box does too
- [ ] Desktop: a screenshot on the clipboard, `Ctrl+Shift+V` / `Cmd+V` on the terminal → `[Image #1]`; dropping a PNG from the file manager onto the terminal → `[Image #1]`, the outline shows while dragging and the page stays put
- [ ] A PDF or a log file → its path at the prompt; asking claude about it works
- [ ] Inside tmux the same file still becomes `[Image #1]`
- [ ] On a slow connection the paperclip pulses until the path appears
- [ ] Write a long passage on the text page: the text running under the paperclip in the box's corner stays readable, and tapping the paperclip still opens the picker rather than moving the caret
- [ ] `ls -la /tmp/webterm-$(id -u)/uploads/` → files `0600`, directory `0700`; a day later they're gone

## Waiting for you (every time the attention rules change, since m16)

[ADR-0052](../20-architecture/adr/0052-waiting-for-you-replaces-unread.md). Two or three sessions, claude in one and codex in another, run directly (not in tmux).

- [ ] claude: give it a task, switch to another session; when it finishes, its row / tab / the session button gets the dot within about a second, while it was working there was none
- [ ] claude with `preferredNotifChannel terminal_bell`: a permission prompt in a background session lights the dot
- [ ] codex with `[tui] notifications = true` and `notification_condition = "always"`: a finished turn in a background session lights the dot. Note whether it came from OSC 9, BEL or the title (`__webterm.attention`, and the name's spinner)
- [ ] Phone and laptop both open: the dot shows on both; opening the session on one clears it on the other
- [ ] Leave a session current and lock the phone; when claude finishes, unlock: the dot is cleared as soon as the page is back, not before

## Terminal compatibility (every time rendering changes)

- [x] `vim` / `nvim`: editing, `:wq`, visual mode, arrow keys
- [ ] `htop`: refresh, arrow keys, `F` keys; switching away and back shows the right screen (snapshot)
- [x] `less` / `man`: paging, search, `q`
- [ ] `tail -f`: follows the bottom under continuous output; scrolling up isn't yanked back down
- [x] `git log` pager and colors
- [x] `Ctrl+C` interrupts `sleep 100`
- [ ] `Ctrl+D` exits the shell → an "[Exited · Enter to close]" line appears at the end, content is kept; `Enter` closes the session
- [ ] Run Claude Code / another TUI agent in a session: sending a long Chinese prompt from the text page works
- [ ] Same, with an image sent first from the paperclip: Enter on the text page submits `[Image #1] <prompt>`
- [x] Print a binary file (`head -c 4096 /dev/urandom`) → no crash, later output is fine
- [x] 256 colors and true color display correctly
- [x] A very long line (100KB, no newline) → doesn't hang

## Session startup (every time the shell launch changes)

- [ ] Brand-new user (empty `.bashrc`): the session starts with a normal prompt
- [ ] PATH set in `~/.bash_profile` is visible in the session (login shell by default); with `--no-login-shell`, `~/.bashrc` is read instead
- [ ] Put a deliberate syntax error in `.bashrc` → the shell still starts
- [ ] `cd` to another directory; the session name follows within 1 second; run `vim` in the session and the name becomes the directory vim is in
- [ ] `--shell zsh` (or fish): the session works and its name follows the directory

## Privacy (every time storage / logging changes)

- [x] `echo WEBTERM_CANARY_TEST` in a session, then `grep -r WEBTERM_CANARY_TEST ~/.local/share/webterm/` → zero hits
- [x] `journalctl -u webterm | grep -E 'pair#|webterm_session='` → zero hits
- [x] Zero hits with `--log-level debug` too

## Record

For every release, record the date, version, and devices / OS you ran this on in the PR or release notes. **Don't just tick boxes without recording the environment**: next time something breaks, you need to know where it was last verified.

| Date | Version | Device / OS | Notes |
|---|---|---|---|
| 2026-09-14 | v0.1.0 | Not recorded | All 60 items in 8 groups passed once |
