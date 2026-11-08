/**
 * The file browser's sheets (ADR-0059): the list of a folder, a file, the name sheet (new
 * folder, rename) and delete confirmation. All are `Drawer`s, so on a phone they are bottom
 * sheets like the session drawer and stack; on wide screens, centered dialogs. Each answers
 * the system Back button for itself.
 *
 * The controller decides where the browser opens and owns what outlives it (uploads, the
 * last folder per session, pasting into the session); this file does the rest.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'

import { Drawer } from '../ui/drawer'
import { BackIcon, FileIcon, FolderIcon, FolderPlusIcon, TerminalIcon, UploadIcon } from '../ui/icons'
import { useRowGestures } from '../ui/rowgestures'
import { ROW_ACT_PX } from '../ui/rowswipe'
import {
  crumbs,
  decodeText,
  failureText,
  fetchFile,
  formatFullTime,
  formatSize,
  formatTime,
  hasNul,
  joinPath,
  listDir,
  makeDir,
  matches,
  validName,
  escapePath,
  mimeOf,
  parentOf,
  previewKind,
  rawUrl,
  readChunk,
  removeEntry,
  renameEntry,
  SHARE_MAX,
  sortEntries,
  TEXT_BYTES,
  type Entry,
  type Failure,
  type Listing,
} from './fs'

export type NotifyKind = 'info' | 'warn' | 'error'

/** Uploads in flight, for the Upload button (AC-9.8). */
export interface UploadProgress {
  /** Files finished so far. */
  done: number
  total: number
  /** The current file, 0–1. */
  fraction: number
}

export interface FilesProps {
  /** The folder to open in. */
  start: string
  home: string | null
  coarse: boolean
  /** The session the browser was opened from is running (Send to session). */
  canSend: boolean
  upload: UploadProgress | null
  /** Bumped when an upload into `dir` finished, so the list reloads. */
  changed: { dir: string; seq: number } | null
  /** The folder shown changed (drops go there; it is remembered on close). */
  onDir(dir: string): void
  onClose(dir: string): void
  onSend(path: string): void
  onTerminal(dir: string): void
  onUpload(dir: string, files: File[]): void
  notify(kind: NotifyKind, text: string): void
  onUnauthorized(): void
}

/**
 * Every action keeps the full path it was started on, so a listing still loading (or reloading)
 * can never point it at a different folder.
 */
type Naming = { kind: 'mkdir'; dir: string } | { kind: 'rename'; entry: Entry; path: string }
interface Target {
  entry: Entry
  path: string
}

/** Two row buttons: Rename · Delete. */
const ROW_ACTIONS = 2 * ROW_ACT_PX

export function FilesBrowser(p: FilesProps) {
  const [dir, setDir] = useState(p.start)
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [file, setFile] = useState<Target | null>(null)
  const [naming, setNaming] = useState<Naming | null>(null)
  const [deleting, setDeleting] = useState<Target | null>(null)
  const rows = useRowGestures<string>(ROW_ACTIONS)
  const loadSeq = useRef(0)
  const crumbRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // `dir` changes only when a listing (or its failure) arrives, so it always names the folder the rows are from
  const dirRef = useRef(dir)
  dirRef.current = dir

  const failed = (f: Failure) => {
    if (f.status === 401) p.onUnauthorized()
  }

  const load = async (path: string) => {
    const seq = ++loadSeq.current
    const r = await listDir(path)
    if (seq !== loadSeq.current) return // a later navigation won
    if (r.ok) {
      setListing(r.listing)
      setError(null)
      setDir(r.listing.path)
      return
    }
    failed(r)
    setListing(null)
    setDir(path)
    setError(r.code === 'forbidden' ? 'Permission denied' : r.code === 'not_found' ? 'Not found' : r.code === 'bad_request' ? 'Not a folder' : "Couldn't load")
  }

  const go = (path: string) => {
    setFilter('')
    rows.setOpen(null)
    void load(path)
  }

  useEffect(() => void load(p.start), [])
  useEffect(() => p.onDir(dir), [dir])
  useEffect(() => {
    if (p.changed && p.changed.dir === dirRef.current) void load(dirRef.current)
  }, [p.changed?.seq])
  // The path starts scrolled to its end (AC-9.3)
  useLayoutEffect(() => {
    const el = crumbRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [dir])

  const path = crumbs(dir, p.home)
  const sorted = useMemo(() => (listing ? sortEntries(listing.entries) : []), [listing])
  const entries = sorted.filter((e) => matches(e.name, filter))
  const more = listing ? listing.total - listing.entries.length : 0
  const at = (e: Entry): Target => ({ entry: e, path: joinPath(listing?.path ?? dir, e.name) })

  const open = (e: Entry) => {
    if (e.bad_name) return
    if (e.type === 'dir') go(at(e).path)
    else setFile(at(e))
  }

  const onRow = (e: Entry) => {
    if (rows.click()) open(e)
  }

  const commitName = async (name: string) => {
    const n = naming
    if (!n) return
    if (n.kind === 'rename' && name === n.entry.name) {
      setNaming(null)
      return
    }
    if (!validName(name)) {
      p.notify('error', 'Invalid name')
      return
    }
    const r = n.kind === 'mkdir' ? await makeDir(n.dir, name) : await renameEntry(n.path, name)
    if (!r.ok) {
      failed(r)
      p.notify('error', failureText(r, n.kind === 'mkdir' ? 'New folder' : 'Rename'))
      return // the sheet stays open for another try
    }
    setNaming(null)
    void load(dirRef.current)
  }

  const commitDelete = async () => {
    const d = deleting
    if (!d) return
    setDeleting(null)
    const r = await removeEntry(d.path)
    if (!r.ok) {
      failed(r)
      p.notify('error', failureText(r, 'Delete'))
    }
    void load(dirRef.current)
  }

  const up = p.upload
  const uploadLabel = !up ? 'Upload' : `${up.total > 1 ? `${up.done + 1}/${up.total} · ` : 'Uploading '}${Math.round(up.fraction * 100)}%`

  return (
    <>
      <Drawer
        title={dir}
        testid="files-sheet"
        backdropTestid="files-backdrop"
        variant="files"
        backButton
        onClose={() => p.onClose(dirRef.current)}
        head={
          <div class="files-head">
            <button
              type="button"
              class="files-up"
              data-testid="files-up"
              aria-label="Up one folder"
              disabled={dir === '/'}
              onClick={() => go(parentOf(dir))}
            >
              <BackIcon size={16} />
            </button>
            <div class="files-crumbs" ref={crumbRef}>
              {path.map((c, i) => (
                <span class="files-crumb-wrap" key={c.path}>
                  {i > 0 && (i > 1 || path[0]?.label !== '/') && <span class="files-sep">/</span>}
                  <button type="button" class="files-crumb" data-testid="files-crumb" onClick={() => go(c.path)}>
                    {c.label}
                  </button>
                </span>
              ))}
            </div>
          </div>
        }
        foot={
          <div class="drawer-actions">
            <button
              type="button"
              class="drawer-btn files-upload"
              data-testid="files-upload"
              data-busy={up ? 'true' : 'false'}
              onClick={() => {
                const el = inputRef.current
                if (!el) return
                el.value = ''
                el.click() // inside the click, or iOS won't open the picker
              }}
            >
              <UploadIcon />
              {uploadLabel}
            </button>
            <button type="button" class="drawer-btn drawer-square" data-testid="files-mkdir" aria-label="New folder" title="New folder" onClick={() => setNaming({ kind: 'mkdir', dir: dirRef.current })}>
              <FolderPlusIcon />
            </button>
            <button
              type="button"
              class="drawer-btn drawer-square"
              data-testid="files-terminal"
              aria-label="New session here"
              title="New session here"
              onClick={() => p.onTerminal(dirRef.current)}
            >
              <TerminalIcon />
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              class="upload-input"
              tabIndex={-1}
              aria-hidden="true"
              data-testid="files-upload-input"
              onChange={(e) => {
                const el = e.currentTarget
                const picked = Array.from(el.files ?? [])
                el.value = ''
                if (picked.length > 0) p.onUpload(dirRef.current, picked)
              }}
            />
          </div>
        }
      >
        <div class="files-filter">
          <input
            type="search"
            data-testid="files-filter"
            placeholder="Filter"
            aria-label="Filter"
            autocomplete="off"
            value={filter}
            onInput={(e) => setFilter(e.currentTarget.value)}
            ref={(el) => {
              if (!el) return
              el.setAttribute('autocorrect', 'off')
              el.setAttribute('autocapitalize', 'off')
              el.setAttribute('spellcheck', 'false')
            }}
          />
        </div>
        {error !== null ? (
          <p class="files-error" data-testid="files-error">
            {error}
          </p>
        ) : (
          <ul class="files-list" data-testid="files-list" onPointerDownCapture={rows.onListPointerDown}>
            {entries.map((e, i) => {
              const opened = !e.bad_name && rows.open === e.name
              return (
                <li key={e.bad_name ? `bad:${i}` : e.name} class="sl-item" data-open={opened ? 'true' : 'false'}>
                  <div class="row-actions" aria-hidden={opened ? undefined : 'true'}>
                    <button
                      type="button"
                      class="row-act"
                      data-act="rename"
                      data-testid="file-row-rename"
                      tabIndex={opened ? 0 : -1}
                      onClick={rows.act(() => setNaming({ kind: 'rename', ...at(e) }))}
                    >
                      Rename
                    </button>
                    <button type="button" class="row-act" data-act="close" data-testid="file-row-delete" tabIndex={opened ? 0 : -1} onClick={rows.act(() => setDeleting(at(e)))}>
                      Delete
                    </button>
                  </div>
                  <div
                    class="file-row"
                    role="button"
                    tabIndex={0}
                    data-testid="files-row"
                    data-name={e.name}
                    data-type={e.type}
                    data-hidden={e.name.startsWith('.') ? 'true' : 'false'}
                    data-bad={e.bad_name ? 'true' : undefined}
                    {...(e.bad_name ? {} : rows.row(e.name))}
                    onClick={() => onRow(e)}
                    onKeyDown={(ev) => {
                      if (ev.target !== ev.currentTarget || (ev.key !== 'Enter' && ev.key !== ' ')) return
                      ev.preventDefault()
                      open(e)
                    }}
                  >
                    <span class="file-icon" data-type={e.type}>
                      {e.type === 'dir' ? <FolderIcon size={18} /> : <FileIcon size={18} />}
                    </span>
                    <span class="file-name">{e.name}</span>
                    <span class="file-info">
                      {e.type === 'file' && <span>{formatSize(e.size)}</span>}
                      <span>{formatTime(e.mtime)}</span>
                    </span>
                  </div>
                </li>
              )
            })}
            {more > 0 && (
              <li class="files-more" data-testid="files-more">
                {more} more
              </li>
            )}
          </ul>
        )}
      </Drawer>

      {file && (
        <FileSheet
          key={file.path}
          path={file.path}
          entry={file.entry}
          coarse={p.coarse}
          canSend={p.canSend}
          onClose={() => setFile(null)}
          onSend={p.onSend}
          notify={p.notify}
          onUnauthorized={p.onUnauthorized}
        />
      )}

      {naming && (
        <NameSheet
          title={naming.kind === 'mkdir' ? 'New folder' : 'Rename'}
          initial={naming.kind === 'mkdir' ? '' : naming.entry.name}
          ok={naming.kind === 'mkdir' ? 'Create' : 'Save'}
          onCommit={(name) => void commitName(name)}
          onCancel={() => setNaming(null)}
        />
      )}

      {deleting && <DeleteConfirm entry={deleting.entry} onOk={() => void commitDelete()} onCancel={() => setDeleting(null)} />}
    </>
  )
}

interface FileSheetProps {
  path: string
  entry: Entry
  coarse: boolean
  canSend: boolean
  onClose(): void
  onSend(path: string): void
  notify(kind: NotifyKind, text: string): void
  onUnauthorized(): void
}

function canShareFile(name: string): boolean {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([], name, { type: mimeOf(name) })] })
  } catch {
    return false
  }
}

/** A file (AC-9.5–AC-9.7): its preview, Share or Download, Send to session. */
function FileSheet({ path, entry, coarse, canSend, onClose, onSend, notify, onUnauthorized }: FileSheetProps) {
  const regular = entry.type === 'file'
  const kind = regular ? previewKind(entry.name) : 'none'
  const long = kind === 'text' && entry.size > TEXT_BYTES
  const [text, setText] = useState<string | null>(null)
  const [binary, setBinary] = useState(false)
  const [tail, setTail] = useState(false)
  const [zoom, setZoom] = useState(false)
  const [fetching, setFetching] = useState(false)
  const shared = useRef<File | null>(null)
  const share = regular && coarse && entry.size <= SHARE_MAX && canShareFile(entry.name)

  useEffect(() => {
    if (kind !== 'text') return
    let live = true
    void readChunk(path, tail).then((r) => {
      if (!live) return
      if (!r.ok) {
        if (r.status === 401) onUnauthorized()
        setText('')
        notify('error', failureText(r, 'Open'))
        return
      }
      if (!tail && hasNul(r.bytes)) setBinary(true)
      else setText(decodeText(r.bytes, tail))
    })
    return () => {
      live = false
    }
  }, [path, tail])

  const doShare = async (f: File) => {
    try {
      await navigator.share({ files: [f] })
    } catch (e) {
      const name = (e as { name?: string }).name
      // NotAllowedError: the tap went stale while the file downloaded; it is kept, so the next tap shares at once
      if (name === 'NotAllowedError' || name === 'AbortError') return
      notify('error', "Couldn't share")
    }
  }

  const onShare = async () => {
    if (shared.current) return doShare(shared.current)
    if (fetching) return
    setFetching(true)
    const r = await fetchFile(path)
    setFetching(false)
    if (!r.ok) {
      if (r.status === 401) onUnauthorized()
      notify('error', failureText(r, 'Share'))
      return
    }
    shared.current = r.file
    await doShare(r.file)
  }

  const onDownload = () => {
    const a = document.createElement('a')
    a.href = rawUrl(path, true)
    a.download = entry.name
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const src = rawUrl(path)
  let view
  if (kind === 'image') {
    view = (
      <div class="file-stage" data-zoom={zoom ? 'true' : undefined}>
        <img src={src} alt={entry.name} data-testid="file-image" data-zoom={zoom ? 'true' : undefined} onClick={() => setZoom(!zoom)} />
      </div>
    )
  } else if (kind === 'video') {
    view = (
      <div class="file-stage">
        <video src={src} controls playsInline preload="metadata" data-testid="file-video" />
      </div>
    )
  } else if (kind === 'audio') {
    view = (
      <div class="file-stage">
        <audio src={src} controls preload="metadata" data-testid="file-audio" />
      </div>
    )
  } else if (kind === 'none' || binary) {
    view = (
      <div class="file-stage file-none" data-testid="file-nopreview">
        <FileIcon size={48} />
      </div>
    )
  } else {
    view = (
      <pre class="file-text" data-testid="file-text" data-tail={tail ? 'true' : undefined}>
        {text ?? ''}
      </pre>
    )
  }

  return (
    <Drawer
      title={entry.name}
      testid="file-sheet"
      backdropTestid="file-backdrop"
      variant="file"
      backButton
      onClose={onClose}
      foot={
        <div class="drawer-actions">
          {share ? (
            <button type="button" class="drawer-btn" data-testid="file-share" disabled={fetching} data-busy={fetching ? 'true' : 'false'} onClick={() => void onShare()}>
              {fetching ? 'Preparing…' : 'Share'}
            </button>
          ) : (
            <button type="button" class="drawer-btn" data-testid="file-download" disabled={!regular} onClick={onDownload}>
              Download
            </button>
          )}
          <button type="button" class="drawer-btn" data-testid="file-send" disabled={!canSend || escapePath(path) === null} onClick={() => onSend(path)}>
            Send to session
          </button>
        </div>
      }
    >
      <div class="file-view" data-kind={binary ? 'none' : kind}>
        <div class="file-meta" data-testid="file-meta">
          <span>{regular ? `${formatSize(entry.size)} · ${formatFullTime(entry.mtime)}` : formatFullTime(entry.mtime)}</span>
          {long && !binary && (
            <button type="button" class="file-end" data-testid="file-end" onClick={() => setTail(!tail)}>
              {tail ? 'Start' : 'End'}
            </button>
          )}
        </div>
        {view}
      </div>
    </Drawer>
  )
}

interface NameSheetProps {
  title: string
  initial: string
  ok: string
  onCommit(name: string): void
  onCancel(): void
}

/** New folder and rename (AC-9.9): the session rename sheet's shape; the part before the extension starts selected. */
function NameSheet({ title, initial, ok, onCommit, onCancel }: NameSheetProps) {
  const ref = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.setAttribute('autocorrect', 'off')
    el.setAttribute('autocapitalize', 'off')
    el.setAttribute('spellcheck', 'false')
    el.setAttribute('enterkeyhint', 'done')
    el.value = initial
    el.focus({ preventScroll: true })
    const dot = initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [])
  const commit = () => {
    const name = (ref.current?.value ?? '').trim()
    if (name !== '') onCommit(name)
  }
  return (
    <Drawer
      title={title}
      testid="name-sheet"
      backdropTestid="name-backdrop"
      variant="rename"
      backButton
      onClose={onCancel}
      foot={
        <div class="drawer-actions">
          <button type="button" class="drawer-btn" data-testid="name-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" class="drawer-btn primary" data-testid="name-ok" onClick={commit}>
            {ok}
          </button>
        </div>
      }
    >
      <div class="rename-field">
        <input
          ref={ref}
          class="rename-sheet-input"
          data-testid="name-input"
          type="text"
          autocomplete="off"
          aria-label="Name"
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
            e.preventDefault()
            commit()
          }}
        />
      </div>
    </Drawer>
  )
}

interface DeleteConfirmProps {
  entry: Entry
  onOk(): void
  onCancel(): void
}

/** Delete confirmation (AC-9.9): the close-confirmation sheet, focus on Delete. */
function DeleteConfirm({ entry, onOk, onCancel }: DeleteConfirmProps) {
  const okRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => okRef.current?.focus({ preventScroll: true }), [])
  return (
    <Drawer
      title={`Delete "${entry.name}"?`}
      testid="delete-confirm"
      backdropTestid="delete-backdrop"
      variant="confirm"
      backButton
      onClose={onCancel}
      foot={
        <div class="drawer-actions">
          <button type="button" class="drawer-btn" data-testid="delete-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" class="drawer-btn danger" data-testid="delete-ok" ref={okRef} onClick={onOk}>
            Delete
          </button>
        </div>
      }
    >
      <p class="confirm-text">{entry.type === 'dir' ? 'Everything in it is deleted too.' : "This can't be undone."}</p>
    </Drawer>
  )
}
