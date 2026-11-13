// Small facts a browser keeps between sign-ins so a sign-in does not
// repeat work it did last time: the user-key generation the collections
// were last swept to, the Spaces whose replica collections were
// provisioned, the annex generations made public. localStorage in the
// browser; a memory for a script, where a fact lasts the run.

const memory = new Map<string, string>()

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

export function recallMark(key: string): string | null {
  const store = storage()
  if (store) {
    try {
      return store.getItem(key)
    } catch {
      // private mode, a full store: the memory below
    }
  }
  return memory.get(key) ?? null
}

export function rememberMark(key: string, value: string): void {
  const store = storage()
  if (store) {
    try {
      store.setItem(key, value)
      return
    } catch {
      // as above
    }
  }
  memory.set(key, value)
}

export const sweptMark = (spaceId: string) => `lcw_swept:${spaceId}`
export const provisionedMark = (spaceId: string) => `lcw_replica_provisioned:${spaceId}`
export const generationPublicMark = (generationId: string) => `lcw_generation_public:${generationId}`
