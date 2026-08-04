import { describe, expect, it } from 'vitest'
import { getParamDisplay } from '../../lib/paramDisplay'
import { DEFAULT_PARAMS, type TaskParams, type TaskRecord } from '../../types'

function taskWithActual(actualParams: Partial<TaskParams>): TaskRecord {
  return {
    params: {
      ...DEFAULT_PARAMS,
      size: '1024x1824',
      output_format: 'png',
    },
    actualParams,
  } as TaskRecord
}

describe('getParamDisplay', () => {
  it('surfaces re-quantized size pixels without flagging an aspect-preserving mismatch', () => {
    const display = getParamDisplay(taskWithActual({ size: '941x1672' }), 'size')

    expect(display.displayValue).toBe('941x1672')
    expect(display.isMismatch).toBe(false)
  })

  it('flags a real size aspect-ratio change', () => {
    const display = getParamDisplay(taskWithActual({ size: '1254x1254' }), 'size')

    expect(display.displayValue).toBe('1254x1254')
    expect(display.isMismatch).toBe(true)
  })

  it('continues to flag mismatches for non-size parameters', () => {
    const display = getParamDisplay(taskWithActual({ output_format: 'webp' }), 'output_format')

    expect(display.displayValue).toBe('webp')
    expect(display.isMismatch).toBe(true)
  })
})
