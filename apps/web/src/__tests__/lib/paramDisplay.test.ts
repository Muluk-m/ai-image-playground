import { describe, expect, it } from 'vitest'
import { getParamDisplay, honorsRequestedSize, measuredSizeOf } from '../../lib/paramDisplay'
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

  it('prefers the measured output pixels over the reported size', () => {
    const display = getParamDisplay(
      taskWithActual({ size: '1024x1824' }),
      'size',
      undefined,
      '1088x1936',
    )

    expect(display.displayValue).toBe('1088x1936')
    expect(display.hasActualValue).toBe(true)
    expect(display.isMismatch).toBe(false)
  })

  it('shows measured pixels for Gemini instead of the leftover OpenAI size', () => {
    // 生产复现：Nano Banana Pro 2K 16:9 出 2752×1536，卡片却写 1024x1024。
    for (const task of [
      { cloudProvider: 'gemini' },
      { apiProvider: 'gemini' },
    ] satisfies Partial<TaskRecord>[]) {
      const gemini = {
        ...taskWithActual({}),
        ...task,
        params: { ...DEFAULT_PARAMS, size: '1024x1024' },
      } as TaskRecord
      const display = getParamDisplay(gemini, 'size', undefined, '2752x1536')

      expect(display.displayValue).toBe('2752x1536')
      expect(display.isMismatch).toBe(false)
      expect(display.isAutoResolved).toBe(false)
    }
  })

  it('does not present the ignored size as the Gemini result before pixels are known', () => {
    const gemini = {
      ...taskWithActual({}),
      cloudProvider: 'gemini',
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
    } as TaskRecord
    const display = getParamDisplay(gemini, 'size')

    expect(display.hasActualValue).toBe(false)
    expect(display.requestedValue).toBe('auto')
    expect(display.displayValue).toBe('auto')
  })

  it('ignores a size echoed back for Gemini and falls back to the mirrored card pixels', () => {
    const gemini = {
      ...taskWithActual({ size: '1024x1024' }),
      cloudProvider: 'gemini',
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
    } as TaskRecord

    expect(getParamDisplay(gemini, 'size').hasActualValue).toBe(false)
    expect(getParamDisplay({ ...gemini, measuredSize: '2752x1536' }, 'size').displayValue).toBe(
      '2752x1536',
    )
  })

  it('ignores a malformed measured size and falls back to the validated values', () => {
    const openai = taskWithActual({ size: '1536x1024' })
    for (const bad of ['unknown', '', '0x768', '12.5x768', '-1x768']) {
      const display = getParamDisplay({ ...openai, measuredSize: bad }, 'size', undefined, bad)
      expect(display.displayValue).toBe('1536x1024')
    }
    const gemini = {
      ...taskWithActual({ size: '1024x1024' }),
      cloudProvider: 'gemini',
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
    } as TaskRecord
    const display = getParamDisplay({ ...gemini, measuredSize: 'unknown' }, 'size')
    expect(display.displayValue).toBe('auto')
    expect(display.hasActualValue).toBe(false)
    // 显式传入的非法值不该挡住任务上已存的合法实测像素。
    expect(
      getParamDisplay({ ...gemini, measuredSize: '2752x1536' }, 'size', undefined, 'bogus')
        .displayValue,
    ).toBe('2752x1536')
    expect(getParamDisplay(openai, 'size', undefined, ' 2048 X 2048 ').displayValue).toBe(
      '2048x2048',
    )
  })

  it('ignores a malformed reported size when no measured pixels exist', () => {
    for (const bad of ['unknown', 'auto', '0x0', '1024']) {
      const display = getParamDisplay(taskWithActual({ size: bad }), 'size')
      expect(display.hasActualValue).toBe(false)
      expect(display.displayValue).toBe('1024x1824')
    }
  })

  it('resolves the provider with the same priority as the detail source line', () => {
    expect(honorsRequestedSize({ apiProvider: 'openai', cloudProvider: 'gemini' })).toBe(true)
    expect(honorsRequestedSize({ apiProvider: 'gemini', cloudProvider: 'openai-compat' })).toBe(
      false,
    )
  })

  it('flags a measured aspect change for providers that honor size', () => {
    // Grok 等按 size 取比例的上游：比例真变了才标出来。
    const display = getParamDisplay(taskWithActual({}), 'size', undefined, '2048x2048')

    expect(display.displayValue).toBe('2048x2048')
    expect(display.isMismatch).toBe(true)
  })

  it('formats measured pixels and recognises Gemini tasks', () => {
    expect(measuredSizeOf({ width: 2752, height: 1536 })).toBe('2752x1536')
    expect(measuredSizeOf({ width: 2752 })).toBeUndefined()
    expect(measuredSizeOf(null)).toBeUndefined()
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 12.5]) {
      expect(measuredSizeOf({ width: bad, height: 768 })).toBeUndefined()
      expect(measuredSizeOf({ width: 1376, height: bad })).toBeUndefined()
    }
    expect(honorsRequestedSize({ cloudProvider: 'gemini' })).toBe(false)
    expect(honorsRequestedSize({ apiProvider: 'gemini' })).toBe(false)
    expect(honorsRequestedSize({ cloudProvider: 'openai-compat' })).toBe(true)
    expect(honorsRequestedSize({ apiProvider: 'openai' })).toBe(true)
  })
})
