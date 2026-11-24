import { describe, expect, it, vi } from 'vitest'
import { createNoteBackNavigation, type NoteBackNavigationPort } from './useNoteBackNavigation'

class FakeBrowser {
  entries: unknown[]
  index: number
  listeners = new Set<() => void>()
  traversals: number[] = []
  readonly push = vi.fn((state: unknown, _unused: string) => {
    this.entries.splice(this.index + 1)
    this.entries.push(structuredClone(state))
    this.index++
  })
  readonly replace = vi.fn((state: unknown, _unused: string) => { this.entries[this.index] = structuredClone(state) })
  readonly back = vi.fn(() => { this.traversals.push(-1) })
  readonly port: NoteBackNavigationPort

  constructor(entries: unknown[] = [{ collection: 'all' }]) {
    this.entries = structuredClone(entries)
    this.index = entries.length - 1
    const browser = this
    this.port = {
      history: { get state() { return browser.entries[browser.index] }, pushState: this.push, replaceState: this.replace, back: this.back },
      listen(listener) { browser.listeners.add(listener); return () => { browser.listeners.delete(listener) } },
    }
  }

  flush() {
    let remaining = 20
    while (this.traversals.length) {
      if (--remaining === 0) throw new Error('History traversal loop')
      const next = this.index + this.traversals.shift()!
      if (next < 0 || next >= this.entries.length) continue
      this.index = next
      for (const listener of this.listeners) listener()
    }
  }
  userBack() { this.back(); this.flush() }
  userForward() { this.traversals.push(1); this.flush() }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('note navigation using device and browser Back', () => {
  it('does not add, replace or traverse history on the ordinary collection screen', () => {
    const browser = new FakeBrowser([{ site: 'previous' }, { collection: 'pinned', search: '기록' }])
    const close = vi.fn()
    const navigation = createNoteBackNavigation(browser.port, close)
    navigation.setNote(null)
    navigation.setNote(null)
    expect(browser.push).not.toHaveBeenCalled()
    expect(browser.replace).not.toHaveBeenCalled()
    expect(browser.back).not.toHaveBeenCalled()
    browser.userBack()
    expect(browser.index).toBe(0)
    expect(close).not.toHaveBeenCalled()
    expect(browser.push).not.toHaveBeenCalled()
    navigation.dispose()
  })

  it('uses exactly one same-URL entry when a note opens, rerenders or changes', () => {
    const browser = new FakeBrowser([{ collection: 'images', routerState: 7 }])
    const navigation = createNoteBackNavigation(browser.port, vi.fn())
    navigation.setNote('first-note')
    navigation.setNote('first-note')
    navigation.setNote('second-note')
    expect(browser.entries).toHaveLength(2)
    expect(browser.push).toHaveBeenCalledTimes(1)
    expect(browser.replace).toHaveBeenCalledTimes(1)
    expect(browser.port.history.state).toMatchObject({ collection: 'images', routerState: 7 })
    expect(browser.push.mock.calls[0]).toHaveLength(2)
    expect(browser.replace.mock.calls[0]).toHaveLength(2)
    navigation.dispose()
  })

  it('returns to the previous collection through the editor close callback', () => {
    const collection = { collection: 'pinned', search: '디자인', tag: '아이디어' }
    const browser = new FakeBrowser([collection])
    const close = vi.fn(() => navigation.setNote(null))
    const navigation = createNoteBackNavigation(browser.port, close)
    navigation.setNote('note')
    browser.userBack()
    expect(close).toHaveBeenCalledTimes(1)
    expect(browser.index).toBe(0)
    expect(browser.port.history.state).toEqual(collection)
    navigation.dispose()
  })

  it('keeps one entry during asynchronous draft saving and coalesces repeated Back', async () => {
    const saved = deferred()
    const browser = new FakeBrowser([{ previousSite: true }, { collection: 'all' }])
    const close = vi.fn(async () => { await saved.promise; navigation.setNote(null) })
    const navigation = createNoteBackNavigation(browser.port, close)
    navigation.setNote('dirty-note')
    browser.userBack()
    browser.userBack()
    expect(close).toHaveBeenCalledTimes(1)
    expect(browser.entries).toHaveLength(3)
    expect(browser.index).toBe(2)
    saved.resolve()
    await saved.promise
    await Promise.resolve()
    browser.flush()
    expect(browser.index).toBe(1)
    expect(browser.port.history.state).toEqual({ collection: 'all' })
    browser.userBack()
    expect(browser.index).toBe(0)
    expect(close).toHaveBeenCalledTimes(1)
    navigation.dispose()
  })

  it('keeps the editor reachable if closing is refused or a draft save fails', async () => {
    const browser = new FakeBrowser()
    const close = vi.fn().mockRejectedValueOnce(new Error('storage full')).mockImplementationOnce(() => navigation.setNote(null))
    const navigation = createNoteBackNavigation(browser.port, close)
    navigation.setNote('unsaved-note')
    browser.userBack()
    expect(browser.index).toBe(1)
    expect(browser.entries).toHaveLength(2)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    browser.userBack()
    expect(close).toHaveBeenCalledTimes(2)
    expect(browser.index).toBe(0)
    navigation.dispose()
  })

  it('consumes a manually closed note without closing a new note opened before popstate arrives', () => {
    const browser = new FakeBrowser()
    const close = vi.fn()
    const navigation = createNoteBackNavigation(browser.port, close)
    navigation.setNote('first-note')
    navigation.setNote(null)
    navigation.setNote('next-note')
    browser.flush()
    expect(close).not.toHaveBeenCalled()
    expect(browser.entries).toHaveLength(2)
    expect(browser.index).toBe(1)
    expect(browser.port.history.state).toMatchObject({ __moa_note_view__: { noteId: 'next-note' } })
    navigation.dispose()
  })

  it('adopts an existing note entry after a StrictMode effect remount without another push', () => {
    const browser = new FakeBrowser()
    const first = createNoteBackNavigation(browser.port, vi.fn())
    first.setNote('deep-linked-note')
    first.dispose()
    const secondClose = vi.fn(() => second.setNote(null))
    const second = createNoteBackNavigation(browser.port, secondClose)
    second.setNote('deep-linked-note')
    expect(browser.entries).toHaveLength(2)
    expect(browser.push).toHaveBeenCalledTimes(1)
    expect(browser.listeners.size).toBe(1)
    browser.userBack()
    expect(secondClose).toHaveBeenCalledTimes(1)
    expect(browser.index).toBe(0)
    second.dispose()
  })

  it('cleans up a retired note entry on reload or Forward without intercepting ordinary root Back', () => {
    const browser = new FakeBrowser([{ previousSite: true }, { collection: 'all' }])
    const first = createNoteBackNavigation(browser.port, vi.fn())
    first.setNote('note-before-reload')
    first.dispose()
    const close = vi.fn()
    const afterReload = createNoteBackNavigation(browser.port, close)
    afterReload.setNote(null)
    browser.flush()
    expect(browser.index).toBe(1)
    browser.userForward()
    expect(browser.index).toBe(1)
    expect(close).not.toHaveBeenCalled()
    browser.userBack()
    expect(browser.index).toBe(0)
    afterReload.dispose()
  })

  it('does not queue two Back traversals when StrictMode remounts while a stale entry is being consumed', () => {
    const browser = new FakeBrowser([{ previousSite: true }, { collection: 'all' }])
    const beforeReload = createNoteBackNavigation(browser.port, vi.fn())
    beforeReload.setNote('note-before-reload')
    beforeReload.dispose()
    const firstMount = createNoteBackNavigation(browser.port, vi.fn())
    firstMount.setNote(null)
    firstMount.dispose()
    const secondMount = createNoteBackNavigation(browser.port, vi.fn())
    secondMount.setNote(null)
    expect(browser.back).toHaveBeenCalledTimes(1)
    browser.flush()
    expect(browser.index).toBe(1)
    expect(browser.port.history.state).toEqual({ collection: 'all' })
    secondMount.dispose()
  })

  it('keeps a newly opened note when it adopts another controller’s pending cleanup', () => {
    const browser = new FakeBrowser()
    const first = createNoteBackNavigation(browser.port, vi.fn())
    first.setNote('old-note')
    first.setNote(null)
    first.dispose()
    const close = vi.fn()
    const second = createNoteBackNavigation(browser.port, close)
    second.setNote('new-note')
    browser.flush()
    expect(close).not.toHaveBeenCalled()
    expect(browser.port.history.state).toMatchObject({ __moa_note_view__: { noteId: 'new-note' } })
    expect(browser.entries).toHaveLength(2)
    second.dispose()
  })
})
