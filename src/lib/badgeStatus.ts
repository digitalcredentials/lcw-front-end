// Whether the account may still collect the alpha testing badge, as the
// back end said at sign-in (`badgeAvailable` in its answer to /login; an
// account may collect the badge a limited number of times). Kept for the
// tab, beside the session, so the signed-in shell knows whether to offer
// the badge without a request of its own. Unknown (a back end that does not
// say) counts as available: the issuer refuses in any case.

const KEY = 'lcw_badge_available'
let memory: boolean | undefined

export function recordBadgeAvailable(value: unknown): void {
  if (typeof value !== 'boolean') {
    return
  }
  memory = value
  try {
    sessionStorage.setItem(KEY, String(value))
  } catch {
    // Outside a browser, or storage is blocked: the memory above
  }
}

// True only when the back end has said the account can collect no more.
export function badgeUnavailable(): boolean {
  try {
    const stored = sessionStorage.getItem(KEY)
    if (stored !== null) {
      return stored === 'false'
    }
  } catch {
    // The memory below
  }
  return memory === false
}
