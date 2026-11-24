import { describe, expect, it, vi } from 'vitest'
import { DraftSaveQueue } from './editor-save'

function deferred() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('editor draft saving', () => {
  it('waits for both the current write and edits arriving while it is in flight', async () => {
    const first = deferred()
    const second = deferred()
    const write = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const queue = new DraftSaveQueue({ body: '' }, write)
    queue.update({ body: '첫 입력' })
    const closing = queue.flush()
    expect(queue.saving).toBe(true)
    expect(queue.unsettled).toBe(true)
    queue.update({ body: '저장 중 추가 입력' })
    expect(queue.flush()).toBe(closing)
    first.resolve()
    await first.promise
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1][0]).toEqual({ body: '저장 중 추가 입력' })
    expect(queue.unsettled).toBe(true)
    second.resolve()
    await closing
    expect(queue.unsettled).toBe(false)
  })

  it('keeps a failed draft pending and retries the latest content', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('storage full')).mockResolvedValue(undefined)
    const queue = new DraftSaveQueue({ body: '' }, write)
    queue.update({ body: '보존할 초안' })
    await expect(queue.flush()).rejects.toThrow('storage full')
    expect(queue.pending).toBe(true)
    expect(queue.saving).toBe(false)
    queue.update({ body: '재시도할 최신 초안' })
    await queue.flush()
    expect(write.mock.calls[1][0]).toEqual({ body: '재시도할 최신 초안' })
    expect(queue.unsettled).toBe(false)
  })

  it('starts the latest pending write immediately when an editor is being unmounted', async () => {
    const complete = deferred()
    const write = vi.fn(() => complete.promise)
    const queue = new DraftSaveQueue({ body: '' }, write)
    queue.update({ body: 'debounce 이전의 마지막 입력' })
    const cleanupSave = queue.flush()
    expect(write).toHaveBeenCalledWith({ body: 'debounce 이전의 마지막 입력' })
    expect(queue.unsettled).toBe(true)
    complete.resolve()
    await cleanupSave
    expect(queue.unsettled).toBe(false)
  })

  it('can retry when a storage adapter throws before returning a promise', async () => {
    const write = vi.fn().mockImplementationOnce(() => { throw new Error('storage unavailable') }).mockResolvedValue(undefined)
    const queue = new DraftSaveQueue({ body: '' }, write)
    queue.update({ body: '복구할 입력' })
    await expect(queue.flush()).rejects.toThrow('storage unavailable')
    expect(queue.saving).toBe(false)
    await queue.flush()
    expect(queue.unsettled).toBe(false)
  })
})
