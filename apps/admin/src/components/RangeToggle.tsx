import { SegmentedControl } from '@/components/SegmentedControl'
import { RANGE_LABEL, RANGES, type Range } from '@/lib/search-params'

const RANGE_OPTIONS = RANGES.map((value) => ({ value, label: RANGE_LABEL[value] }))

export function RangeToggle({
  value,
  onChange,
}: {
  value: Range
  onChange: (next: Range) => void
}) {
  return (
    <SegmentedControl options={RANGE_OPTIONS} value={value} onChange={onChange} label="时间范围" />
  )
}
