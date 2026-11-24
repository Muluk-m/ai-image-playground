import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useSlidingIndicator } from '@/hooks/useSlidingIndicator'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T | ''
  onChange: (next: T) => void
  label: string
}) {
  const { containerRef, indicatorStyle, visible } = useSlidingIndicator(value)

  return (
    <div
      ref={containerRef}
      className="relative inline-flex h-8 items-center rounded-md border border-input bg-background p-0.5 text-xs"
    >
      {visible && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 z-0 rounded bg-primary shadow-sm"
          style={indicatorStyle}
        />
      )}
      <ToggleGroup
        type="single"
        aria-label={label}
        value={value}
        onValueChange={(next) => {
          // Radix 允许再次点击当前项取消选择，这里忽略空值以保证始终有选中项。
          if (next) onChange(next as T)
        }}
        className="inline-flex h-full items-center gap-0"
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            className={`relative z-[1] h-auto min-w-0 rounded px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-fast ease-motion-out hover:bg-transparent hover:text-foreground data-[state=on]:text-primary-foreground motion-reduce:transition-none ${
              visible ? 'data-[state=on]:bg-transparent' : 'data-[state=on]:bg-primary'
            }`}
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}
