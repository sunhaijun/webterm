/**
 * UT-upload-1: which pastes and drags count as files (ADR-0051 §2, input.md §Sending
 * files), and the failure toasts.
 */
import { describe, expect, it } from 'vitest'

import { MAX_UPLOAD_MB, dragHasFiles, pastedFiles, sessionGoneError, uploadError } from '../src/app/uploads'

/** jsdom has no DataTransfer; these are the parts the code reads. */
function transfer(text: string, files: File[], types: string[] = files.length ? ['Files'] : []): DataTransfer {
  return {
    getData: (t: string) => (t === 'text/plain' ? text : ''),
    files,
    types: text ? [...types, 'text/plain'] : types,
  } as unknown as DataTransfer
}

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image.png', { type: 'image/png' })

describe('UT-upload-1 pastes and drags', () => {
  it('a clipboard with files and no text is files (a screenshot)', () => {
    const f = png()
    expect(pastedFiles(transfer('', [f]))).toEqual([f])
  })

  it('anything with text is an ordinary text paste, files or not', () => {
    expect(pastedFiles(transfer('echo hi', []))).toBeNull()
    expect(pastedFiles(transfer('https://example.com/a.png', [png()]))).toBeNull()
  })

  it('an empty clipboard, or none, is not files', () => {
    expect(pastedFiles(transfer('', []))).toBeNull()
    expect(pastedFiles(null)).toBeNull()
  })

  it('a drag counts only when it carries files', () => {
    expect(dragHasFiles(transfer('', [png()]))).toBe(true)
    expect(dragHasFiles(transfer('selected text', [], []))).toBe(false)
    expect(dragHasFiles(null)).toBe(false)
  })

  it('toasts name the file and, for 413, the limit', () => {
    expect(uploadError(413, 'big.mov')).toBe(`big.mov is too large (max ${MAX_UPLOAD_MB} MB)`)
    expect(uploadError(500, 'a.png')).toBe('Upload failed: a.png')
    expect(uploadError(0, 'a.png')).toBe('Upload failed: a.png')
    expect(sessionGoneError('a.png')).toBe('Session ended; a.png not inserted')
  })
})
