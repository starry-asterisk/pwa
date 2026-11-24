import { generateVAPIDKeys } from 'web-push'
import { writeFile } from 'node:fs/promises'
const keys = generateVAPIDKeys()
const lines = [`VAPID_PUBLIC_KEY=${keys.publicKey}`, `VAPID_PRIVATE_KEY=${keys.privateKey}`, 'VAPID_SUBJECT=mailto:you@example.com', '']
await writeFile(new URL('../.env.push.local', import.meta.url), lines.join(String.fromCharCode(10)), { flag: 'wx' })
console.log('Push keys created in .env.push.local. Copy only the public key into the app settings.')