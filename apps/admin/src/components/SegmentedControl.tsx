import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

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
  value: T
  onChange: (next: T) => void
  label: string
}) {
  return (
    <ToggleGroup
      type="single"
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        // Radix 允许再次点击当前项取消选择，这里忽略空值以保证始终有选中项。
        if (next) onChange(next as T)
      }}
      className="inline-flex h-8 items-center gap-0 rounded-md border border-input bg-background p-0.5 text-xs"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className="h-auto min-w-0 rounded px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
