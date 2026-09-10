import { useEffect, useRef, useState } from "react"


export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value)
  const lastEmitRef = useRef(Number.NEGATIVE_INFINITY)
  const latestRef = useRef(value)

  useEffect(() => {
    latestRef.current = value
    const elapsed = performance.now() - lastEmitRef.current
    if (elapsed >= intervalMs) {
      lastEmitRef.current = performance.now()
      setThrottled(value)
      return
    }
    const id = window.setTimeout(() => {
      lastEmitRef.current = performance.now()
      setThrottled(latestRef.current)
    }, intervalMs - elapsed)
    return () => window.clearTimeout(id)
  }, [intervalMs, value])

  return throttled
}
