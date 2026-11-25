import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ImageOff, Video } from 'lucide-react'
import { db } from '../lib/db'
import type { Attachment } from '../types'
function useAttachmentUrl(id: string) {
  const record = useLiveQuery(() => db.images.get(id), [id])
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!record?.blob) { setUrl(''); return }
    const next = URL.createObjectURL(record.blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [record?.blob])
  return url
}

export function VideoView({ video }: { video: Attachment }) {
  const url = useAttachmentUrl(video.id)
  if (!url) return <div className="image-placeholder"><Video size={24} /><span>연결되면 녹화를 불러옵니다</span></div>
  return <video className="video-player" src={url} controls playsInline preload="metadata" width={video.width} height={video.height} aria-label="화면 녹화" />
}

export default function ImageView({ image, className = '', onClick }: { image: Attachment; className?: string; onClick?: () => void }) {
  const url = useAttachmentUrl(image.id)
  if (!url) return <div className={`image-placeholder ${className}`}><ImageOff size={24} /><span>연결되면 이미지를 불러옵니다</span></div>
  return <img src={url} alt={image.name} className={className} width={image.width} height={image.height} onClick={onClick} loading="lazy" />
}