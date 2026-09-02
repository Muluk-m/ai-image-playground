import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { RANGES, type Range } from '@/lib/search-params'

export const RANGE_LABEL: Record<Range, string> = {
  '1d': '1 天',
  '7d': '7 天',
  '30d': '30 天',
}

export function RangeToggle({
  value,
  onChange,
}: {
  value: Range
  onChange: (next: Range) => void
}) {
  return (
    <ToggleGroup
      type="single"
      aria-label="时间范围"
      value={value}
      onValueChange={(next) => {
        // Radix 允许再次点击当前项取消选择，这里忽略空值以保证时间窗始终有效。
        if (next) onChange(next as Range)
      }}
      className="inline-flex h-8 items-center gap-0 rounded-md border border-input bg-background p-0.5 text-xs"
    >
      {RANGES.map((range) => (
        <ToggleGroupItem
          key={range}
          value={range}
          className="h-auto min-w-0 rounded px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
        >
          {RANGE_LABEL[range]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
