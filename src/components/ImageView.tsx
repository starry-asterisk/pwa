import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ImageOff } from 'lucide-react'
import { db } from '../lib/db'
import type { Attachment } from '../types'
export default function ImageView({ image, className = '', onClick }: { image: Attachment; className?: string; onClick?: () => void }) {
  const record = useLiveQuery(() => db.images.get(image.id), [image.id])
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!record?.blob) { setUrl(''); return }
    const next = URL.createObjectURL(record.blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [record?.blob])
  if (!url) return <div className={`image-placeholder ${className}`}><ImageOff size={24} /><span>연결되면 이미지를 불러옵니다</span></div>
  return <img src={url} alt={image.name} className={className} width={image.width} height={image.height} onClick={onClick} loading="lazy" />
}