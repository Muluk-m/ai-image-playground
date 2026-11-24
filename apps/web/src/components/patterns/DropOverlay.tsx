export default function DropOverlay({ label }: { label: string }) {
  return (
    <div className="animate-overlay-in pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-card/85 text-sm font-medium text-primary backdrop-blur-sm">
      <span className="animate-modal-in">{label}</span>
    </div>
  )
}
