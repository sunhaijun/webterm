/**
 * What this origin keeps on the device, cleared when signing out (ADR-0048). The agent
 * also sends `Clear-Site-Data`, which does all of this in Chromium and Firefox; this is
 * for the browsers that ignore it. Each step tolerates a browser that lacks the API or
 * refuses it (private mode).
 */
export async function clearLocalData(): Promise<void> {
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith('webterm.')) keys.push(k)
    }
    for (const k of keys) localStorage.removeItem(k)
  } catch {
    /* storage unavailable */
  }
  try {
    for (const reg of (await navigator.serviceWorker?.getRegistrations()) ?? []) await reg.unregister()
  } catch {
    /* no service worker support */
  }
  try {
    if (typeof caches !== 'undefined') for (const k of await caches.keys()) await caches.delete(k)
  } catch {
    /* no Cache Storage */
  }
}
