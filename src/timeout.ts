/**
 * Thrown by {@link withTimeout} when the wrapped work does not settle within
 * the deadline. The CLI's top-level handler maps this to a dedicated exit code
 * so a wedged run fails loudly instead of lingering as a 100%-CPU zombie.
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/**
 * Races `work` against a watchdog timer. Resolves with `work`'s value if it
 * settles first; rejects with a {@link TimeoutError} (naming `label` and `ms`)
 * if the timer wins. The timer is `ref`'d on purpose — it keeps the event loop
 * alive so the watchdog is guaranteed to fire even when `work` is parked on a
 * resource that would otherwise let the process appear idle. It is always
 * cleared once the race settles, so a completed run leaves no pending timer to
 * keep the process alive.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const watchdog = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`${label} timed out after ${ms}ms`))
    }, ms)
  })
  try {
    return await Promise.race([work, watchdog])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
