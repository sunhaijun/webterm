/**
 * Sending files to a session (ADR-0051, input.md §Sending files): which clipboard and drag
 * contents count as files, the upload request, and the toast for each failure. The
 * controller does the rest: target session, order, and pasting the returned path.
 */

/** What the agent said about one upload. `status` 0 = the request never got an answer. */
export type UploadOutcome = { ok: true; path: string } | { ok: false; status: number }

export type Upload = (file: File) => Promise<UploadOutcome>

/** POST /api/uploads with the file as the body (http-api.md#uploads). */
export const uploadFile: Upload = async (file) => {
  try {
    const r = await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
    if (r.status !== 201) return { ok: false, status: r.status }
    const body = (await r.json()) as { path?: unknown }
    return typeof body.path === 'string' && body.path !== '' ? { ok: true, path: body.path } : { ok: false, status: r.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

/**
 * The files a paste carries, or null for an ordinary text paste. A clipboard with any
 * text is text, files or not: "Copy image" in a browser can put both on it, and pasting
 * the text is what a terminal user expects.
 */
export function pastedFiles(data: DataTransfer | null): File[] | null {
  if (!data || data.getData('text/plain') !== '') return null
  const files = Array.from(data.files ?? [])
  return files.length > 0 ? files : null
}

/** Whether a drag carries files (as opposed to selected text or a link). */
export function dragHasFiles(data: DataTransfer | null): boolean {
  return !!data && Array.from(data.types ?? []).includes('Files')
}

/** The limit the agent enforces (MaxFileBytes in internal/uploads), for the toast. */
export const MAX_UPLOAD_MB = 20

/** The toast for a failed upload of `name`. */
export function uploadError(status: number, name: string): string {
  return status === 413 ? `${name} is too large (max ${MAX_UPLOAD_MB} MB)` : `Upload failed: ${name}`
}

/** The toast when the session ended before the path could be pasted. */
export function sessionGoneError(name: string): string {
  return `Session ended; ${name} not inserted`
}
