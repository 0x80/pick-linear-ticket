import { describe, expect, it, vi } from 'vitest'
import { TimeoutError, withTimeout } from './timeout.ts'

describe('withTimeout', () => {
  it('resolves with the work value when it settles before the timeout', async () => {
    expect(await withTimeout(Promise.resolve('picked'), 1000, 'pick')).toBe('picked')
  })

  it('rejects with a TimeoutError when the work never settles', async () => {
    const never = new Promise<never>(() => {})
    await expect(withTimeout(never, 20, 'pick')).rejects.toBeInstanceOf(TimeoutError)
  })

  it('names the operation and the limit in the timeout message', async () => {
    const never = new Promise<never>(() => {})
    await expect(withTimeout(never, 20, 'pick-linear-ticket')).rejects.toThrow(
      /pick-linear-ticket.*20ms/,
    )
  })

  it('propagates the original rejection when the work fails before the timeout', async () => {
    const failing = Promise.reject(new Error('linear-cli blew up'))
    await expect(withTimeout(failing, 1000, 'pick')).rejects.toThrow('linear-cli blew up')
  })

  it('clears its watchdog timer once the work settles, leaving no pending timer', async () => {
    vi.useFakeTimers()
    try {
      const result = await withTimeout(Promise.resolve('ok'), 60_000, 'pick')
      expect(result).toBe('ok')
      /** A leftover timer is exactly what would keep the process alive forever. */
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
