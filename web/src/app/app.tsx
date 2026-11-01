/**
 * webterm 主界面的装配（ADR-0025）：一块全屏终端 + 两种形态的会话切换 + 附加键。
 *
 * 只做装配。状态与动作在 `controller.ts`，各块界面在同目录的组件里。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'

import { ExtraKeys } from '../keys/extrakeys'
import { Drawer } from '../ui/drawer'
import { GearIcon, PlusIcon } from '../ui/icons'
import { AppController } from './controller'
import { showsExtraKeys } from './form'
import { ConnBanner, ImePreview, ToastView } from './notices'
import { CloseConfirm } from './confirm'
import { RenameSheet, SessionList, SessionMenu } from './sessions'
import { Settings } from './settings'
import { TopBar } from './tabs'

interface MenuAt {
  sid: number
  x: number
  y: number
}

export interface AppProps {
  /** 设备被吊销：交给闸门换成配对引导页（AC-1.11）。 */
  onRevoked?(): void
}

export function App({ onRevoked }: AppProps = {}) {
  const ctl = useMemo(() => new AppController(), [])
  const [, setTick] = useState(0)
  const rerender = () => setTick((n) => n + 1)
  const rootRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const [renaming, setRenaming] = useState<number | null>(null)

  // 【先订阅、再挂载，而且都在 layout effect 里】：mount() 一调就开始连。useEffect 排在绘制之后，
  // 本机 / 局域网上 welcome 可能比它先到 —— 那次 set() 一个监听者都没有，界面就停在初始的
  // 「连接中…」，直到下一次碰巧的状态变化（E2E 实测：连上了、会话也建了，横幅一直是连接中）
  useLayoutEffect(() => ctl.subscribe(rerender), [ctl])
  useLayoutEffect(() => ctl.mount(areaRef.current!, rootRef.current!), [ctl])

  const s = ctl.get()
  useEffect(() => {
    if (s.revoked) onRevoked?.()
  }, [s.revoked])
  const keys = showsExtraKeys(s.form, s.coarse)
  const atLimit = s.sessions.length >= s.maxSessions
  const menuSession = menu ? s.sessions.find((x) => x.sid === menu.sid) : undefined
  const closing = s.closing === null ? undefined : s.sessions.find((x) => x.sid === s.closing)
  // compact 上改名是一张叠在抽屉上的小 sheet（ADR-0039 §2）；wide 是标签上原地改
  const renamingSheet = s.form === 'compact' && renaming !== null ? s.sessions.find((x) => x.sid === renaming) : undefined
  const anyUnread = s.sessions.some((x) => x.unread)
  const empty = s.welcomed && s.sessions.length === 0

  // 菜单 / 改名对着的会话没了（别处关掉、agent 重启）：状态也清掉 —— sid 会复用，
  // 留着的话会对着后来同号的新会话弹出来（ADR-0038 §4 同理）
  useEffect(() => {
    if (menu && !menuSession) setMenu(null)
    if (renaming !== null && !s.sessions.some((x) => x.sid === renaming)) setRenaming(null)
  })

  // 改完名（或取消）输入框就没了，焦点会落回 body：鼠标设备上还给终端
  const endRename = () => {
    setRenaming(null)
    if (s.form === 'wide' && !s.coarse) ctl.focusTerm()
  }
  const rename = (sid: number, name: string) => {
    endRename()
    ctl.rename(sid, name)
  }

  return (
    <div class="app" ref={rootRef} data-form={s.form} data-coarse={s.coarse ? 'true' : 'false'} data-keys={keys ? 'true' : 'false'}>
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
          onMove={(sid, before) => ctl.moveSession(sid, before)}
        />
      )}

      <div class="stage">
        <div class="term" data-testid="terminal" ref={areaRef} />
        <ConnBanner state={s.conn} info={s.connInfo} fatal={s.fatal} />
        <ToastView toast={s.toast} />
        <ImePreview preview={s.preview} fontSize={s.fontSize} />
        {empty && (
          <div class="empty" data-testid="empty">
            <p>没有会话</p>
            <button data-testid="empty-new-session" onClick={() => ctl.newSession(true)}>
              新建会话
            </button>
          </div>
        )}
      </div>

      {keys && (
        <ExtraKeys
          form={s.form}
          count={s.sessions.length}
          unread={anyUnread}
          sticky={ctl.sticky}
          page={s.page}
          onOpenSessions={() => ctl.openSessions()}
          onTogglePage={() => ctl.togglePage()}
          onKey={(id) => ctl.pressKey(id)}
          onSend={(send) => ctl.sendText(send)}
          register={(els) => ctl.registerTextPage(els)}
        />
      )}

      {s.sessionsOpen && (
        <Drawer
          title="会话"
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
                title={atLimit ? `会话数已达上限 ${s.maxSessions}` : undefined}
                onClick={() => ctl.newFromDrawer()}
              >
                <PlusIcon />
                新会话
              </button>
              <button
                type="button"
                class="drawer-btn drawer-settings"
                data-testid="open-settings"
                aria-label="设置"
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
          onClose={() => ctl.closeSettings()}
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
    </div>
  )
}
