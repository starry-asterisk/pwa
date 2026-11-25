export interface SharedCapture {
  id: string
  title: string
  text: string
  files: File[]
  createdAt: string
  recording?: { width: number; height: number }
}
function openInbox(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('moa-share-inbox', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('captures', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export async function storeCapture(capture: SharedCapture): Promise<void> {
  const inbox = await openInbox()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = inbox.transaction('captures', 'readwrite')
      transaction.objectStore('captures').put(capture)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { inbox.close() }
}
export async function readCapture(id: string): Promise<SharedCapture | undefined> {
  const inbox = await openInbox()
  try {
    return await new Promise((resolve, reject) => {
      const request = inbox.transaction('captures', 'readonly').objectStore('captures').get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally { inbox.close() }
}
export async function deleteCapture(id: string): Promise<void> {
  const inbox = await openInbox()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = inbox.transaction('captures', 'readwrite')
      transaction.objectStore('captures').delete(id)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  } finally { inbox.close() }
}