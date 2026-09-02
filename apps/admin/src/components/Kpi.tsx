import { Card, CardContent } from '@/components/ui/card'

export function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </p>
        <p className="mt-3 font-mono text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  )
}
