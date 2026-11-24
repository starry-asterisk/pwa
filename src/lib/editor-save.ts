/** Serializes draft writes and drains edits made while a previous write is in flight. */
export class DraftSaveQueue<T> {
  private latest: T
  private revision = 0
  private savedRevision = 0
  private running: Promise<void> | null = null

  constructor(initial: T, private readonly write: (draft: T) => Promise<void>, private readonly onStateChange: () => void = () => {}) {
    this.latest = initial
  }

  get pending(): boolean { return this.savedRevision < this.revision }
  get saving(): boolean { return this.running !== null }
  get unsettled(): boolean { return this.pending || this.saving }

  update(draft: T): void {
    this.latest = draft
    this.revision++
    this.onStateChange()
  }

  flush(): Promise<void> {
    if (this.running) return this.running
    if (!this.pending) return Promise.resolve()
    const operation = async () => {
      try {
        while (this.pending) {
          const revision = this.revision
          const snapshot = this.latest
          let write: Promise<void>
          try { write = this.write(snapshot) } catch (error) { write = Promise.reject(error) }
          await write
          this.savedRevision = revision
        }
      } finally {
        // Clear synchronously with the final pending check, before resolving
        // callers, so a subsequent edit cannot join a completed operation.
        this.running = null
        this.onStateChange()
      }
    }
    this.running = operation()
    this.onStateChange()
    return this.running
  }
}
