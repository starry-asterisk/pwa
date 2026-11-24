import { useEffect, useRef } from 'react'

const markerKey = '__moa_note_view__'
interface NoteEntry { version: 1; token: string; noteId: string }

interface HistoryPort {
  readonly state: unknown
  pushState: (state: unknown, unused: string) => void
  replaceState: (state: unknown, unused: string) => void
  back: () => void
}
export interface NoteBackNavigationPort {
  history: HistoryPort
  listen: (listener: () => void) => () => void
}
// React StrictMode can remount an effect before its asynchronous history.back()
// delivers popstate. Share that pending traversal with the replacement listener.
const pendingRemovals = new WeakMap<HistoryPort, string>()

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function noteEntry(state: unknown): NoteEntry | null {
  if (!record(state) || !Object.prototype.hasOwnProperty.call(state, markerKey)) return null
  const entry = state[markerKey]
  return record(entry) && entry.version === 1 && typeof entry.token === 'string' && entry.token !== ''
    && typeof entry.noteId === 'string' && entry.noteId !== '' ? entry as unknown as NoteEntry : null
}

/** Owns only a transient, same-URL note entry. Existing root history is left intact. */
export function createNoteBackNavigation(port: NoteBackNavigationPort, onRequestClose: () => void | Promise<void>) {
  let activeNote: string | null = null
  let entryToken: string | null = null
  let consuming = false
  let consumingToken: string | null = null
  let disposed = false
  let closeRequest: symbol | null = null

  function ensureEntry() {
    if (!activeNote || disposed) return
    const existing = noteEntry(port.history.state)
    const token = existing?.token ?? entryToken ?? crypto.randomUUID()
    entryToken = token
    if (existing?.noteId === activeNote && existing.token === token) return
    const state = {
      ...(record(port.history.state) ? port.history.state : {}),
      [markerKey]: { version: 1, token, noteId: activeNote } satisfies NoteEntry,
    }
    // Changing the displayed note or remounting in StrictMode reuses one entry.
    if (existing) port.history.replaceState(state, '')
    else port.history.pushState(state, '')
  }

  function consumeEntry() {
    const existing = noteEntry(port.history.state)
    if (consuming || !existing) return
    consuming = true
    consumingToken = existing.token
    if (pendingRemovals.get(port.history) === existing.token) return
    pendingRemovals.set(port.history, existing.token)
    port.history.back()
  }

  function requestClose() {
    if (closeRequest || !activeNote || disposed) return
    const request = Symbol('note-close')
    closeRequest = request
    let result: void | Promise<void>
    try { result = onRequestClose() } catch {
      closeRequest = null
      return
    }
    // The editor owns persistence and reports a failed save. Keep its history
    // entry while it is open so failure or image processing cannot discard it.
    void Promise.resolve(result).catch(() => {}).finally(() => {
      if (closeRequest === request) closeRequest = null
    })
  }

  const unlisten = port.listen(() => {
    if (disposed) return
    if (consuming) {
      consuming = false
      if (pendingRemovals.get(port.history) === consumingToken) pendingRemovals.delete(port.history)
      consumingToken = null
      // A different note may have opened before our programmatic back completed.
      if (activeNote) ensureEntry()
      return
    }
    if (!activeNote) {
      // A browser Forward or reload can reveal a retired transient entry. It
      // cannot reopen an editor without loading and authorizing the note first.
      consumeEntry()
      return
    }
    const current = noteEntry(port.history.state)
    if (current?.token === entryToken && current.noteId === activeNote) return
    // Back has reached the underlying collection. Rearm before asynchronous
    // editor saving starts; another Back then stays inside this same document.
    ensureEntry()
    requestClose()
  })

  return {
    setNote(noteId: string | null) {
      if (disposed) return
      const existing = noteEntry(port.history.state)
      if (!consuming && existing && pendingRemovals.get(port.history) === existing.token) {
        consuming = true
        consumingToken = existing.token
      }
      if (activeNote !== noteId) closeRequest = null
      activeNote = noteId
      if (!noteId) consumeEntry()
      else if (!consuming) ensureEntry()
    },
    dispose() { disposed = true; closeRequest = null; unlisten() },
  }
}

/**
 * The callback must invoke NoteEditor's save-and-close path, rather than simply
 * unmounting it. Setting noteId to null consumes our entry after saving succeeds.
 */
export function useNoteBackNavigation(noteId: string | null, onRequestClose: () => void | Promise<void>): void {
  const latest = useRef({ noteId, onRequestClose })
  latest.current = { noteId, onRequestClose }
  const controller = useRef<ReturnType<typeof createNoteBackNavigation> | null>(null)

  useEffect(() => {
    const instance = createNoteBackNavigation({
      history: window.history,
      listen(listener) {
        window.addEventListener('popstate', listener)
        return () => window.removeEventListener('popstate', listener)
      },
    }, () => latest.current.onRequestClose())
    controller.current = instance
    instance.setNote(latest.current.noteId)
    return () => {
      instance.dispose()
      if (controller.current === instance) controller.current = null
    }
  }, [])

  useEffect(() => { controller.current?.setNote(noteId) }, [noteId])
}
