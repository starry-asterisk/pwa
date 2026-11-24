import { useEffect, useId, useRef, useState } from 'react'
import { Copy, Download, Image as ImageIcon, LoaderCircle, Share2, X } from 'lucide-react'
import type { Attachment } from '../types'
import { db, formatBytes } from '../lib/db'
import { createPngBlob, downloadBlob } from '../lib/media'
import { copyNoteText, downloadNoteText, pngFilename, shareNoteText, sharePngImage, sharedNoteText, supportsFileSharing, supportsTextSharing } from '../lib/sharing'
import './ShareDialog.css'

interface Props {
  title: string
  body: string
  images: Attachment[]
  initialImageId?: string
  onClose: () => void
  notify: (message: string) => void
}
export default function ShareDialog({ title, body, images, initialImageId, onClose, notify }: Props) {
  const dialog = useRef<HTMLElement>(null)
  const identifier = useId()
  const close = useRef(onClose)
  close.current = onClose
  const [imageId, setImageId] = useState(initialImageId || images[0]?.id || '')
  const [png, setPng] = useState<File | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  const text = sharedNoteText(title, body)
  const nativeText = supportsTextSharing()
  const nativeImage = png ? supportsFileSharing([png]) : false
  useEffect(() => {
    mounted.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.querySelector<HTMLButtonElement>('[data-share-close]')?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
      if (event.key !== 'Tab' || !dialog.current) return
      const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]')].filter(element => element.getClientRects().length > 0)
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => { mounted.current = false; document.removeEventListener('keydown', keydown); previous?.focus() }
  }, [])
  useEffect(() => {
    let active = true
    setPng(null); setError('')
    if (!imageId) { setPreparing(false); return }
    setPreparing(true)
    void (async () => {
      const image = await db.images.get(imageId)
      if (!image) throw new Error('이미지가 아직 이 기기에 없습니다. 동기화한 뒤 다시 시도해 주세요.')
      const blob = await createPngBlob(image.blob)
      if (active) setPng(new File([blob], pngFilename(image.name), { type: 'image/png' }))
    })().catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '이미지를 준비하지 못했습니다.') })
      .finally(() => { if (active) setPreparing(false) })
    return () => { active = false }
  }, [imageId])
  async function run(action: () => Promise<unknown>, success?: string) {
    if (busy) return
    setBusy(true)
    try { await action(); if (success) notify(success) }
    catch (reason) { notify(reason instanceof Error ? reason.message : '공유하지 못했습니다.') }
    finally { if (mounted.current) setBusy(false) }
  }
  function shareText() {
    void run(async () => {
      const result = await shareNoteText(title, body)
      if (result === 'shared') notify('메모를 공유했어요.')
      else if (result === 'unsupported') notify('이 기기에서는 텍스트 복사나 파일 저장을 이용해 주세요.')
    })
  }
  function shareImage() {
    if (!png) return
    void run(async () => {
      const result = await sharePngImage(png, title)
      if (result === 'shared') notify('이미지를 PNG로 공유했어요.')
      else if (result === 'unsupported') notify('이 기기에서는 PNG로 다운로드한 뒤 원하는 앱에 보내 주세요.')
    })
  }
  return <div className="modal-backdrop settings-backdrop share-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="settings-dialog share-dialog" role="dialog" aria-modal="true" aria-labelledby={`${identifier}-title`} ref={dialog} tabIndex={-1}>
      <header className="settings-header"><div><h2 id={`${identifier}-title`}>다른 앱으로 보내기</h2><p>원하는 앱이나 기기로 기록을 보내세요.</p></div><button className="icon-button" aria-label="공유 닫기" data-share-close onClick={onClose}><X size={20} /></button></header>
      <div className="settings-content">
        <section className="settings-section"><h3>메모 텍스트</h3>
          <p className="settings-help">제목과 내용을 함께 보냅니다.</p>
          {text ? <div className="share-text-preview">{text.length > 250 ? `${text.slice(0, 250)}…` : text}</div> : <p className="settings-help">텍스트를 적으면 함께 보낼 수 있어요.</p>}
          <div className="settings-actions">
            {nativeText && <button className="button primary" disabled={busy || !text} onClick={shareText}><Share2 size={16} />텍스트 공유</button>}
            <button className={`button ${nativeText ? 'secondary' : 'primary'}`} disabled={busy || !text} onClick={() => { void run(() => copyNoteText(title, body), '메모 텍스트를 복사했어요.') }}><Copy size={16} />텍스트 복사</button>
            <button className="button ghost" disabled={busy || !text} onClick={() => { try { downloadNoteText(title, body) } catch (reason) { notify(reason instanceof Error ? reason.message : '파일을 만들지 못했습니다.') } }}><Download size={16} />텍스트 파일 저장</button>
          </div>
          {!nativeText && <p className="settings-help share-fallback">이 브라우저에서는 공유 메뉴 대신 복사하거나 파일로 저장할 수 있어요.</p>}
        </section>
        {images.length > 0 && <section className="settings-section"><h3>이미지 보내기</h3><p className="settings-help">보낼 이미지를 고르면 PNG로 준비해 드립니다.</p>
          <label className="settings-field"><span>공유할 이미지</span><select className="share-image-picker" aria-label="공유할 이미지" value={imageId} disabled={busy} onChange={event => setImageId(event.target.value)}>{images.map((image, index) => <option key={image.id} value={image.id}>{index + 1}. {image.name}</option>)}</select></label>
          <div className="share-image-status" role="status">{preparing ? <><LoaderCircle className="spin" size={18} /><span>PNG 이미지를 준비하고 있어요…</span></> : error ? <span>{error}</span> : png ? <><ImageIcon size={18} /><span>{png.name}<small>{formatBytes(png.size)} · PNG</small></span></> : null}</div>
          <div className="settings-actions">{nativeImage && <button className="button primary" disabled={busy || preparing || !png} onClick={shareImage}><Share2 size={16} />이미지 공유</button>}
            <button className={`button ${nativeImage ? 'secondary' : 'primary'}`} disabled={busy || preparing || !png} onClick={() => { if (png) downloadBlob(png, png.name) }}><Download size={16} />PNG 다운로드</button></div>
          {!preparing && !error && !nativeImage && <p className="settings-help share-fallback">이 브라우저에서는 파일 공유를 지원하지 않아요. PNG로 내려받아 원하는 앱에 첨부해 주세요.</p>}
        </section>}
      </div>
    </section>
  </div>
}