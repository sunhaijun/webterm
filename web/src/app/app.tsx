/**
 * Main screen assembly (ADR-0025): a full-screen terminal, session switching in
 * two form factors, and the extra keys.
 *
 * Wiring only. State and actions live in `controller.ts`; each piece of UI is a
 * component in this directory.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'

import { FilesBrowser } from '../files/browser'
import { ExtraKeys } from '../keys/extrakeys'
import { Drawer } from '../ui/drawer'
import { FolderIcon, GearIcon, PlusIcon } from '../ui/icons'
import { AppController } from './controller'
import { showsExtraKeys } from './form'
import { CommandEditor, CommandItemSheet, KeyMenus } from './keymenus'
import { KeysRestore } from './keysrestore'
import { ClipBar, LinkPopover } from './linkpop'
import { ConnBanner, ImePreview, ToastView } from './notices'
import { CloseConfirm, SignOutConfirm } from './confirm'
import { RenameSheet, SessionList, SessionMenu } from './sessions'
import { Settings } from './settings'
import { TopBar } from './tabs'

interface MenuAt {
  sid: number
  x: number
  y: number
}

export interface AppProps {
  /** Called when the device is revoked; the gate swaps in the pairing page (AC-1.11). */
  onRevoked?(): void
  /** Called when this device signed itself out (AC-1.22); the gate swaps in the pairing page. */
  onSignedOut?(): void
}

export function App({ onRevoked, onSignedOut }: AppProps = {}) {
  const ctl = useMemo(() => new AppController(), [])
  const [, setTick] = useState(0)
  const rerender = () => setTick((n) => n + 1)
  const rootRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const [renaming, setRenaming] = useState<number | null>(null)

  // Subscribe before mounting, both in layout effects. mount() starts connecting
  // right away; a useEffect runs after paint, and on localhost/LAN the welcome
  // can arrive first. That set() would then have no listener and the banner would
  // stay on "Connecting…" until some unrelated state change.
  useLayoutEffect(() => ctl.subscribe(rerender), [ctl])
  useLayoutEffect(() => ctl.mount(areaRef.current!, rootRef.current!), [ctl])

  const s = ctl.get()
  useEffect(() => {
    if (s.revoked) onRevoked?.()
  }, [s.revoked])
  useEffect(() => {
    if (s.signedOut) onSignedOut?.()
  }, [s.signedOut])
  const keys = showsExtraKeys(s.form, s.coarse)
  const atLimit = s.sessions.length >= s.maxSessions
  const menuSession = menu ? s.sessions.find((x) => x.sid === menu.sid) : undefined
  const closing = s.closing === null ? undefined : s.sessions.find((x) => x.sid === s.closing)
  // compact renames in a small sheet over the drawer (ADR-0039 §2); wide renames the tab in place
  const renamingSheet = s.form === 'compact' && renaming !== null ? s.sessions.find((x) => x.sid === renaming) : undefined
  const anyAttention = s.sessions.some((x) => x.attention)
  // Send to session needs the session the file browser was opened from, still running (AC-9.7)
  const filesSession = s.files?.sid != null ? s.sessions.find((x) => x.sid === s.files?.sid) : undefined
  const empty = s.welcomed && s.sessions.length === 0

  // The session behind the menu or rename is gone (closed elsewhere, agent restart):
  // clear that state too. Sids are reused, so stale state would pop up over a new
  // session with the same sid (same reasoning as ADR-0038 §4).
  useEffect(() => {
    if (menu && !menuSession) setMenu(null)
    if (renaming !== null && !s.sessions.some((x) => x.sid === renaming)) setRenaming(null)
  })

  // Once the rename input goes away focus falls back to body; on mouse devices hand it back to the terminal
  const endRename = () => {
    setRenaming(null)
    if (s.form === 'wide' && !s.coarse) ctl.focusTerm()
  }
  const rename = (sid: number, name: string) => {
    endRename()
    ctl.rename(sid, name)
  }

  return (
    <div
      class="app"
      ref={rootRef}
      data-form={s.form}
      data-coarse={s.coarse ? 'true' : 'false'}
      data-keys={keys ? 'true' : 'false'}
      data-files-drop={s.dropping && s.files ? 'true' : undefined}
    >
      {s.form === 'wide' && (
        <TopBar
          sessions={s.sessions}
          conn={s.conn}
          connInfo={s.connInfo}
          atLimit={atLimit}
          maxSessions={s.maxSessions}
          renaming={renaming}
          onSelect={(sid) => ctl.select(sid)}
          onClose={(sid) => ctl.requestClose(sid)}
          onNew={() => ctl.newSession()}
          onMenu={(sid, x, y) => setMenu({ sid, x, y })}
          onRenameStart={(sid) => setRenaming(sid)}
          onRename={rename}
          onCancelRename={endRename}
          onSettings={() => ctl.openSettings()}
          onFiles={() => ctl.openFiles()}
          onUpload={() => ctl.pickFiles()}
          uploading={s.uploading}
          onMove={(sid, before) => ctl.moveSession(sid, before)}
        />
      )}

      <div class="stage" data-drop={s.dropping && !s.files ? 'true' : undefined}>
        <div class="term" data-testid="terminal" ref={areaRef} />
        <ConnBanner state={s.conn} info={s.connInfo} fatal={s.fatal} note={s.connNote} />
        <ToastView toast={s.toast} />
        <ClipBar offer={s.clip} onCopy={() => ctl.copyClip()} onClose={ctl.dismissClip} />
        <ImePreview preview={s.preview} fontSize={s.fontSize} />
        {empty && (
          <div class="empty" data-testid="empty">
            <p>No sessions</p>
            <button data-testid="empty-new-session" onClick={() => ctl.newSession(true)}>
              New session
            </button>
          </div>
        )}
      </div>

      {keys && (
        <ExtraKeys
          form={s.form}
          count={s.sessions.length}
          attention={anyAttention}
          sticky={ctl.sticky}
          page={s.page}
          onOpenSessions={() => ctl.openSessions()}
          onTogglePage={() => ctl.togglePage()}
          collapsed={s.keysCollapsed}
          onCollapse={() => ctl.collapseKeys()}
          onKey={(id) => ctl.pressKey(id)}
          onMenu={(m) => ctl.openMenu(m)}
          menu={s.keyMenu}
          commands={ctl.hasCommands()}
          onSend={(send) => ctl.sendText(send)}
          register={(els) => ctl.registerTextPage(els)}
          onUpload={() => ctl.pickFiles()}
          uploading={s.uploading}
        />
      )}

      {keys && s.keysCollapsed && (
        <KeysRestore attention={anyAttention} onRestore={() => ctl.restoreKeys()} onPreview={ctl.previewRestore} />
      )}

      {/* Both paperclips open this one input (ADR-0051 §2): any file type, several at once */}
      <input
        type="file"
        multiple
        class="upload-input"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="upload-input"
        ref={(el) => ctl.registerFileInput(el)}
        onChange={() => ctl.onFilesPicked()}
      />

      {s.sessionsOpen && (
        <Drawer
          title="Sessions"
          testid="session-drawer"
          variant="sessions"
          backButton
          onClose={() => ctl.closeSessions()}
          foot={
            <div class="drawer-actions">
              <button
                type="button"
                class="drawer-btn drawer-new"
                data-testid="new-session"
                disabled={atLimit}
                title={atLimit ? `Session limit reached (${s.maxSessions})` : undefined}
                onClick={() => ctl.newFromDrawer()}
              >
                <PlusIcon />
                New session
              </button>
              <button
                type="button"
                class="drawer-btn drawer-square"
                data-testid="open-files"
                aria-label="Files"
                title="Files"
                onClick={() => ctl.openFiles()}
              >
                <FolderIcon />
              </button>
              <button
                type="button"
                class="drawer-btn drawer-settings"
                data-testid="open-settings"
                aria-label="Settings"
                onClick={() => ctl.openSettings()}
              >
                <GearIcon />
              </button>
            </div>
          }
        >
          <SessionList
            sessions={s.sessions}
            home={s.home}
            onSelect={(sid) => ctl.selectFromDrawer(sid)}
            onTogglePin={(sid) => ctl.togglePin(sid)}
            onRename={(sid) => setRenaming(sid)}
            onClose={(sid) => ctl.requestClose(sid)}
            onMove={(sid, before) => ctl.moveSession(sid, before)}
          />
        </Drawer>
      )}

      {s.settingsOpen && (
        <Settings
          theme={s.theme}
          fontSize={s.fontSize}
          onTheme={(t) => ctl.setTheme(t)}
          onFontSize={(px) => ctl.setFontSize(px)}
          onSignOut={() => ctl.requestSignOut()}
          onClose={() => ctl.closeSettings()}
        />
      )}

      {s.files && (
        <FilesBrowser
          start={s.files.start}
          home={s.home}
          coarse={s.coarse}
          wide={s.form === 'wide'}
          canSend={filesSession?.status === 'running'}
          upload={s.filesUpload}
          changed={s.filesChanged}
          onDir={(dir) => ctl.setFilesDir(dir)}
          onClose={(dir) => ctl.closeFiles(dir)}
          onSend={(path) => ctl.sendFromFiles(path)}
          onTerminal={(dir) => ctl.newSessionIn(dir)}
          onUpload={(dir, files) => ctl.uploadToDir(dir, files)}
          notify={(kind, text) => ctl.notify(kind, text)}
          onUnauthorized={() => ctl.unauthorized()}
        />
      )}

      {menu && menuSession && (
        <SessionMenu
          session={menuSession}
          x={menu.x}
          y={menu.y}
          onDismiss={() => setMenu(null)}
          onRename={() => {
            setMenu(null)
            setRenaming(menu.sid)
          }}
          onTogglePin={() => {
            setMenu(null)
            ctl.togglePin(menu.sid)
          }}
          onClose={() => {
            setMenu(null)
            ctl.requestClose(menu.sid)
          }}
        />
      )}

      {renamingSheet && (
        <RenameSheet name={renamingSheet.name} onCommit={(name) => rename(renamingSheet.sid, name)} onCancel={endRename} />
      )}

      {closing && <CloseConfirm name={closing.name} onOk={() => ctl.confirmClose()} onCancel={() => ctl.cancelClose()} />}

      {s.signingOut && <SignOutConfirm onOk={() => void ctl.confirmSignOut()} onCancel={() => ctl.cancelSignOut()} />}

      <LinkPopover pop={s.linkPop} onOpen={() => ctl.openLink()} onCopy={() => ctl.copyLink()} onClose={ctl.closeLinkPop} />
      <KeyMenus
        menu={s.keyMenu}
        strip={s.strip}
        onRun={(id) => ctl.runCommand(id)}
        onEdit={() => ctl.openEditor()}
        onClose={ctl.closeMenu}
      />
      {s.editorOpen && (
        <CommandEditor
          strip={s.strip}
          onMove={(from, to) => ctl.moveCommand(from, to)}
          onToggle={(id) => ctl.toggleCommand(id)}
          onEditItem={(id) => ctl.openItemForm(id)}
          onAdd={() => ctl.openItemForm('')}
          onReset={() => ctl.resetCommands()}
          onRefresh={() => ctl.refreshCommands()}
          onClose={ctl.closeEditor}
        />
      )}
      {s.editorOpen && s.itemForm !== null && (
        <CommandItemSheet
          key={s.itemForm}
          item={s.strip?.items.find((x) => x.id === s.itemForm) ?? null}
          onSave={(f) => ctl.saveItemForm(f)}
          onDelete={s.strip?.items.find((x) => x.id === s.itemForm)?.origin === 'added' ? () => ctl.deleteItem() : undefined}
          onCancel={ctl.closeItemForm}
        />
      )}
    </div>
  )
}
