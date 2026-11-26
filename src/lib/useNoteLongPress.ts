import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from 'react'

const holdMs = 500
const movementLimit = 10

interface Press {
  pointerId: number
  pointerType: string
  x: number
  y: number
  timer: ReturnType<typeof setTimeout>
  fired: boolean
}

export function useNoteLongPress(scope: string, onSelect: (id: string) => void) {
  const press = useRef<Press | null>(null)
  const pressedNote = useRef<string | null>(null)

  const cancel = useCallback(() => {
    clearTimeout(press.current?.timer)
    press.current = null
  }, [])

  useEffect(() => {
    window.addEventListener('scroll', cancel, true)
    window.addEventListener('blur', cancel)
    return () => {
      cancel()
      window.removeEventListener('scroll', cancel, true)
      window.removeEventListener('blur', cancel)
    }
  }, [cancel, scope])

  function start(event: PointerEvent<HTMLElement>, id: string) {
    if (!event.isPrimary) return
    cancel()
    pressedNote.current = null
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, a, input, textarea, select')) return
    press.current = {
      pointerId: event.pointerId, pointerType: event.pointerType, x: event.clientX, y: event.clientY, fired: false,
      timer: setTimeout(() => {
        if (!press.current) return
        press.current.fired = true
        pressedNote.current = id
        onSelect(id)
      }, holdMs),
    }
  }

  function move(event: PointerEvent<HTMLElement>) {
    const current = press.current
    if (current?.pointerId === event.pointerId && Math.hypot(event.clientX - current.x, event.clientY - current.y) > movementLimit) cancel()
  }

  function end(event: PointerEvent<HTMLElement>) {
    if (press.current?.pointerId === event.pointerId) cancel()
  }

  function contextMenu(event: MouseEvent<HTMLElement>) {
    if (press.current?.pointerType === 'touch' || press.current?.fired) event.preventDefault()
  }

  function consumeClick(event: MouseEvent<HTMLElement>, id: string) {
    if (event.detail === 0 || pressedNote.current !== id) return false
    pressedNote.current = null
    return true
  }

  return { start, move, end, contextMenu, consumeClick }
}
