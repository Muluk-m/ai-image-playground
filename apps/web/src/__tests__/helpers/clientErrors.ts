import type { ClientErrorBatch } from '@image-playground/shared'
import { onTestFinished, vi } from 'vitest'
import {
  _resetErrorReportingForTesting,
  configureErrorReporting,
  flushClientErrors,
} from '../../lib/errorReporting'

export function captureClientErrors() {
  _resetErrorReportingForTesting()
  configureErrorReporting('https://api.test')
  const previous = Object.getOwnPropertyDescriptor(navigator, 'sendBeacon')
  const blobs: Blob[] = []
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: vi.fn((_url: string, body: Blob) => {
      blobs.push(body)
      return true
    }),
  })
  onTestFinished(() => {
    _resetErrorReportingForTesting()
    if (previous) Object.defineProperty(navigator, 'sendBeacon', previous)
    else Reflect.deleteProperty(navigator, 'sendBeacon')
  })
  return async (): Promise<ClientErrorBatch[]> => {
    flushClientErrors()
    return await Promise.all(
      blobs.map(
        (blob) =>
          new Promise<ClientErrorBatch>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(JSON.parse(String(reader.result)))
            reader.onerror = () => reject(reader.error)
            reader.readAsText(blob)
          }),
      ),
    )
  }
}
