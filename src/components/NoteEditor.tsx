import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Check, ChevronDown, Download, Eye, ImagePlus, LoaderCircle, Pin, RotateCcw, Trash2, X } from 'lucide-react'
import { attachImages, db, formatBytes, removeAttachment, updateNote } from '../lib/db'
import { downloadImageAsPng, optimizeImage } from '../lib/media'
import { DraftSaveQueue } from '../lib/editor-save'
import type { Attachment, Note } from '../types'
import ImageView from './ImageView'
import Markdown from './Markdown'

interface Props { note: Note; onClose: () => void; notify: (message: string) => void }
export default function NoteEditor({ note, onClose, notify }: Props) {
  // App supplies the initial snapshot after waiting for active synchronization.
  // Only metadata follows IndexedDB changes; the user's draft remains local here.
  const currentNote = useLiveQuery(() => db.notes.get(note.id), [note.id], note) || note
  const [title, setTitle] = useState(note.title)
  const [body, setBody] = useState(note.body)
  const [tagText, setTagText] = useState(note.tags.join(', '))
  const [preview, setPreview] = useState(false)
  const [saved, setSaved] = useState(true)
  const [processing, setProcessing] = useState(false)
  const [closing, setClosing] = useState(false)
  const [lossless, setLossless] = useState(false)
  const [resize, setResize] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [lightbox, setLightbox] = useState<Attachment | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const draft = useRef({ title, body, tags: note.tags })
  const mounted = useRef(true)
  const processingRef = useRef(false)
  const closingRef = useRef(false)
  const saves = useRef<DraftSaveQueue<typeof draft.current> | null>(null)
  if (!saves.current) saves.current = new DraftSaveQueue(draft.current,
    content => updateNote(note.id, content),
    () => { if (mounted.current) setSaved(!saves.current!.unsettled) })
  useEffect(() => {
    mounted.current = true
    const previous = document.activeElement as HTMLElement | null
    if (!note.title && !note.body) titleRef.current?.focus()
    else bodyRef.current?.focus()
    return () => {
      mounted.current = false
      clearTimeout(timeout.current)
      // Account changes or navigation can unmount before the debounce fires.
      void flush().catch(() => {})
      previous?.focus()
    }
  }, [])
  async function flush(): Promise<void> {
    clearTimeout(timeout.current)
    try {
      await saves.current!.flush()
    } catch (error) {
      if (mounted.current) setSaved(false)
      notify(error instanceof Error ? error.message : '저장하지 못했습니다. 저장공간을 확인해 주세요.')
      throw error
    }
  }
  function changed(next: { title?: string; body?: string; tags?: string[] }) {
    if (closingRef.current) return
    draft.current = { ...draft.current, ...next }
    saves.current!.update(draft.current)
    clearTimeout(timeout.current)
    timeout.current = setTimeout(() => { void flush().catch(() => {}) }, 450)
  }
  useEffect(() => {
    const saveWhenHidden = () => { if (document.visibilityState === 'hidden') void flush().catch(() => {}) }
    const beforeLeave = (event: BeforeUnloadEvent) => {
      if (saves.current!.unsettled || processingRef.current) {
        event.preventDefault()
        event.returnValue = ''
        void flush().catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', saveWhenHidden)
    window.addEventListener('beforeunload', beforeLeave)
    return () => { document.removeEventListener('visibilitychange', saveWhenHidden); window.removeEventListener('beforeunload', beforeLeave) }
  }, [])
  async function close() {
    if (processingRef.current || closingRef.current) return
    closingRef.current = true
    setClosing(true)
    try { await flush(); onClose() } catch { /* flush already surfaced the storage error. */ } finally {
      closingRef.current = false
      if (mounted.current) setClosing(false)
    }
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const scope = lightbox ? dialogRef.current?.querySelector('.lightbox') : dialogRef.current
        const items = Array.from(scope?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]):not([hidden]), textarea:not([disabled]), summary, a[href]') || []).filter(item => item.getClientRects().length > 0)
        const first = items[0], last = items[items.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
      if (event.key === 'Escape') { if (lightbox) setLightbox(null); else void close() }
      if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void flush().catch(() => {}) }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  })
  async function addFiles(files: File[]) {
    if (processingRef.current || closingRef.current || currentNote.deletedAt || !files.length) return
    if (files.length > 10) { notify('이미지는 한 번에 10장까지 추가할 수 있어요.'); return }
    if (currentNote.attachments.length + files.length > 100) { notify('메모 한 개에는 이미지를 100장까지 담을 수 있어요.'); return }
    processingRef.current = true
    setProcessing(true)
    try {
      await flush()
      const images = []
      for (const file of files) {
        images.push(await optimizeImage(file, { lossless: lossless || file.type === 'image/png', ...(resize ? { maxDimension: 2560 } : {}) }))
      }
      await attachImages(note.id, images)
      notify(`${images.length}장의 이미지를 WebP로 저장했어요.`)
    } catch (error) { notify(error instanceof Error ? error.message : '이미지를 저장하지 못했습니다.') }
    finally { processingRef.current = false; if (mounted.current) setProcessing(false) }
  }
  async function download(image: Attachment) {
    try {
      const stored = await db.images.get(image.id)
      if (!stored) throw new Error('이미지가 아직 이 기기에 없습니다. 동기화한 뒤 다시 시도해 주세요.')
      await downloadImageAsPng(stored)
    } catch (error) { notify(error instanceof Error ? error.message : '다운로드하지 못했습니다.') }
  }
  async function trash() {
    if (processingRef.current || closingRef.current) return
    closingRef.current = true
    setClosing(true)
    try {
      await flush()
      await updateNote(note.id, { deletedAt: currentNote.deletedAt ? null : new Date().toISOString(), pinned: currentNote.deletedAt ? currentNote.pinned : false })
      notify(currentNote.deletedAt ? '메모를 다시 꺼냈어요.' : '메모를 휴지통으로 옮겼어요.')
      onClose()
    } catch (error) { notify(error instanceof Error ? error.message : '메모를 이동하지 못했습니다.') }
    finally { closingRef.current = false; if (mounted.current) setClosing(false) }
  }
  return <div className="modal-backdrop editor-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) void close() }}>
    <section ref={dialogRef} className="editor-dialog" role="dialog" aria-modal="true" aria-label="메모 편집" onDrop={event => { event.preventDefault(); setDragging(false); void addFiles(Array.from(event.dataTransfer.files)) }} onDragOver={event => { event.preventDefault(); setDragging(true) }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }} onPaste={event => {
      const files = Array.from(event.clipboardData.files)
      if (files.length) { event.preventDefault(); void addFiles(files) }
    }}>
      <div className="editor-toolbar">
        <div className="saved-state">{saved ? <Check size={15} /> : <LoaderCircle size={15} className="spin" />}<span>{saved ? '이 기기에 저장됨' : '저장 중'}</span></div>
        <div className="toolbar-actions">
          {!currentNote.deletedAt && <button className={`icon-button ${currentNote.pinned ? 'selected' : ''}`} title={currentNote.pinned ? '고정 해제' : '메모 고정'} aria-label={currentNote.pinned ? '고정 해제' : '메모 고정'} disabled={closing || processing} onClick={() => void updateNote(note.id, { pinned: !currentNote.pinned }).catch(error => notify(error.message))}><Pin size={18} /></button>}
          <button className={`icon-button ${preview ? 'selected' : ''}`} title="미리보기" aria-label="미리보기" aria-pressed={preview} onClick={() => setPreview(!preview)}><Eye size={19} /></button>
          <button className="icon-button" title={currentNote.deletedAt ? '메모 복원' : '휴지통으로 이동'} aria-label={currentNote.deletedAt ? '메모 복원' : '휴지통으로 이동'} disabled={closing || processing} onClick={() => void trash()}>{currentNote.deletedAt ? <RotateCcw size={18} /> : <Trash2 size={18} />}</button>
          <span className="toolbar-divider" />
          <button className="button small primary" onClick={() => void close()} disabled={processing || closing}>{closing ? '저장 중' : '완료'}</button>
        </div>
      </div>
      {currentNote.deletedAt && <div className="trash-notice">휴지통에 있는 메모입니다. 복원하면 다시 편집할 수 있어요.</div>}
      <div className="editor-scroll">
        <input ref={titleRef} className="editor-title" aria-label="메모 제목" placeholder="어떤 생각을 담아둘까요?" maxLength={200} value={title} disabled={closing || Boolean(currentNote.deletedAt)} onChange={event => { setTitle(event.target.value); changed({ title: event.target.value }) }} />
        <div className="editor-date">{new Intl.DateTimeFormat('ko', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(note.createdAt))}<span>·</span>나만의 메모</div>
        {preview ? <div className="editor-preview">{body ? <Markdown text={body} /> : <p className="muted">아직 적어둔 내용이 없어요.</p>}</div> : <textarea ref={bodyRef} aria-label="메모 내용" className="editor-body" placeholder={'떠오른 생각, 기억할 문장, 놓치기 아까운 링크.\n무엇이든 편하게 적어두세요.\n\nMarkdown도 사용할 수 있어요.'} value={body} maxLength={500_000} disabled={closing || Boolean(currentNote.deletedAt)} onChange={event => { setBody(event.target.value); changed({ body: event.target.value }) }} />}
        {currentNote.attachments.length > 0 && <div className="editor-images">{currentNote.attachments.map(image => <div className="editor-image" key={image.id}>
          <button className="image-open" aria-label={`${image.name} 크게 보기`} onClick={() => setLightbox(image)}><ImageView image={image} /></button>
          <div className="image-caption"><span title={image.name}>{image.name}<small>{formatBytes(image.size)} · WebP</small></span><button className="icon-button" title="PNG로 다운로드" aria-label={`${image.name} PNG로 다운로드`} onClick={() => void download(image)}><Download size={16} /></button>{!currentNote.deletedAt && <button className="icon-button" title="이미지 제거" aria-label={`${image.name} 제거`} disabled={closing || processing} onClick={() => void removeAttachment(note.id, image.id).catch(error => notify(error.message))}><X size={16} /></button>}</div>
        </div>)}</div>}
        {!currentNote.deletedAt && <>
          <div className={`attachment-drop ${dragging ? 'dragging' : ''}`}>
            <button className="attachment-add" onClick={() => inputRef.current?.click()} disabled={processing || closing}>{processing ? <LoaderCircle className="spin" size={21} /> : <ImagePlus size={21} />}<span>{processing ? '이미지를 가볍게 만드는 중…' : '이미지를 놓거나, 눌러서 추가하세요'}<small>붙여넣기도 가능해요 · PNG / JPG / WebP</small></span></button>
            <details className="image-options"><summary>저장 옵션 <ChevronDown size={14} /></summary><label><input type="checkbox" checked={lossless} onChange={event => setLossless(event.target.checked)} />사진도 무손실로 저장</label><label><input type="checkbox" checked={resize} onChange={event => setResize(event.target.checked)} />긴 변 2,560px로 줄이기</label><p>PNG는 항상 무손실로 저장합니다. 기본 해상도는 유지해요.</p></details>
          </div>
          <label className="tag-input"><span>#</span><input aria-label="태그" placeholder="태그를 쉼표로 구분해 추가" value={tagText} maxLength={600} disabled={closing} onChange={event => { setTagText(event.target.value); changed({ tags: [...new Set(event.target.value.split(',').map(tag => tag.trim().replace(/^#/, '').slice(0, 40)).filter(Boolean))].slice(0, 20) }) }} /></label>
        </>}
      </div>
      <footer className="editor-footer"><span>생각은 자유롭게, 저장은 자동으로.</span><span>이미지는 WebP · 다운로드는 PNG</span></footer>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden aria-label="이미지 파일 선택" onChange={event => { void addFiles(Array.from(event.target.files || [])); event.target.value = '' }} />
      {dragging && <div className="editor-drag-overlay"><ImagePlus size={40} /><strong>여기에 놓으면 메모에 담겨요</strong></div>}
      {lightbox && <div className="lightbox" role="dialog" aria-modal="true" aria-label="이미지 크게 보기" onClick={() => setLightbox(null)}><button className="lightbox-close icon-button" aria-label="이미지 닫기" onClick={() => setLightbox(null)}><X /></button><ImageView image={lightbox} /><button className="button" onClick={event => { event.stopPropagation(); void download(lightbox) }}><Download size={17} />PNG로 다운로드</button></div>}
    </section>
  </div>
}
