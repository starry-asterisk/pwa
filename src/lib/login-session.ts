/** The Supabase session ID stays stable when its access token is refreshed. */
export function loginSessionId(accessToken: string | undefined): string | null {
  const payload = accessToken?.split('.')[1]
  if (!payload) return null
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as { session_id?: unknown } | null
    const id = claims?.session_id
    return typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ? id : null
  } catch {
    return null
  }
}
