/** Admission and execution are counted together so shutdown cannot race asynchronous startup. */
export class DrainState {
  private draining = false
  private active = 0
  private failure = false

  enter(): (() => void) | null {
    if (this.draining) return null
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
    }
  }

  begin(): void {
    this.draining = true
  }
  /**
   * A durable settlement write failed. Reported for the operator, but it no longer holds the
   * instance: a rollout stops it at the drain deadline anyway, and the recovery scan seals the
   * turn once its lease expires (ADR 0009, superseded in part on 2026-09-18).
   */
  failed(): void {
    this.failure = true
  }
  status() {
    return {
      draining: this.draining,
      active: this.active,
      safeToStop: this.draining && this.active === 0,
      failed: this.failure,
    }
  }
}

export const bffDrain = new DrainState()
