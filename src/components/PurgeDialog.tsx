import { useEffect, useRef } from 'react'
import { LoaderCircle, Trash2 } from 'lucide-react'

interface Props {
  count: number
  cloud: boolean
  busy: boolean
  error: string
  onCancel: () => void
  onConfirm: () => void
}

export default function PurgeDialog({ count, cloud, busy, error, onCancel, onConfirm }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const opener = document.activeElement
    const modal = dialog.current
    modal?.showModal()
    cancel.current?.focus()
    return () => {
      modal?.close()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

  return <dialog
    ref={dialog}
    className="purge-dialog"
    aria-labelledby="purge-title"
    aria-describedby="purge-description"
    onCancel={event => { event.preventDefault(); if (!busy) onCancel() }}
  >
    <h2 id="purge-title">메모 {count}개를 영구 삭제할까요?</h2>
    <p id="purge-description">
      삭제한 메모와 첨부 파일은 복원할 수 없어요.
      {cloud && ' 동기화되면 내 다른 기기에서도 삭제돼요.'}
    </p>
    {error && <p className="purge-error" role="alert">{error}</p>}
    <div className="purge-dialog-actions">
      <button ref={cancel} type="button" className="button secondary" disabled={busy} onClick={onCancel}>취소</button>
      <button type="button" className="button danger-solid" disabled={busy} onClick={onConfirm}>
        {busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
        {busy ? '삭제 중…' : '영구 삭제'}
      </button>
    </div>
  </dialog>
}
