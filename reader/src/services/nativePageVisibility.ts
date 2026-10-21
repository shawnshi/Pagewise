import { jsonObject, stateError, type JsonObject } from './nativeState.ts'
export type NativeVisibilitySend = (action: string, payload: JsonObject) => Promise<unknown>
export interface NativeVisibilityResult { applied: boolean; obsolete?: boolean }
/** Module-wide page owner, not a component-local epoch. Dispatch is ordered; delayed native ACKs don't block newer intentions. */
export function createNativePageVisibility(session: string, send: NativeVisibilitySend, timeoutMs = 35_000) {
  if (!session || !(timeoutMs > 0)) throw stateError('native_protocol_mismatch')
  let intent = 0, owner: string | null = null, dispatch: Promise<unknown> = Promise.resolve()
  let leaving: { owner: string; promise: Promise<NativeVisibilityResult> } | null = null
  const obsolete = (): NativeVisibilityResult => ({ applied: false, obsolete: true })
  async function bounded(action: string, payload: JsonObject) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(stateError('native_visibility_timeout')), timeoutMs) })
    try { return jsonObject(await Promise.race([Promise.resolve().then(() => send(action, payload)), deadline])) }
    finally { clearTimeout(timer) }
  }
  function transition(kind: 'show' | 'hide', page?: string, params?: JsonObject): Promise<NativeVisibilityResult> {
    const current = ++intent
    const task = dispatch.then(async () => {
      if (current !== intent) return { reply: Promise.resolve(obsolete()) }
      const ticket = await bounded('visibilityTicket', { session, intent: current })
      if (current !== intent) return { reply: Promise.resolve(obsolete()) }
      if (ticket.session !== session || !Number.isSafeInteger(ticket.generation) || Number(ticket.generation) < 1) throw stateError('stale_native_visibility')
      const payload: JsonObject = { session, generation: ticket.generation }
      if (kind === 'show') { payload.page = page; payload.params = params ?? {} }
      const reply = bounded(kind, payload).then(value => {
        if (current !== intent) return obsolete()
        if (value.applied !== true || value.visible !== (kind === 'show')) throw stateError('stale_native_visibility')
        return { applied: true }
      })
      // Serialize dispatch, NOT the physical completion of an old draft/visibility request.
      return { reply }
    })
    dispatch = task.then(() => undefined, () => undefined)
    return task.then(result => result.reply).catch(error => { if (current !== intent) return obsolete(); throw error })
  }
  return {
    show(nextOwner: string, page: string, params: JsonObject): Promise<NativeVisibilityResult> {
      if (!nextOwner) return Promise.reject(stateError('invalid_payload'))
      owner = nextOwner
      return transition('show', page, params)
    },
    hide(previousOwner: string): Promise<NativeVisibilityResult> {
      // Two concurrent route guards for the same owner must both await the SAME leave ACK.
      if (leaving?.owner === previousOwner && owner === null) return leaving.promise
      if (owner !== previousOwner) return Promise.resolve(obsolete())
      owner = null
      const current = intent + 1
      const promise = transition('hide').catch(error => { if (intent === current && owner === null) owner = previousOwner; throw error })
      const pending = { owner: previousOwner, promise }
      leaving = pending
      void promise.then(() => { if (leaving === pending) leaving = null }, () => { if (leaving === pending) leaving = null })
      return promise
    },
  }
}
