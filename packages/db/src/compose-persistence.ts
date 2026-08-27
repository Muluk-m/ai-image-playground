import type {
  NewPixelObject,
  PixelStore,
  QueuePersistence,
  SubmitCommand,
  SubmitOutcome,
} from './stores'

export function composeQueuePersistence(
  tasks: QueuePersistence,
  pixels: PixelStore,
): QueuePersistence {
  return {
    tasks: tasks.tasks,
    pixels,
    async submit(command: SubmitCommand): Promise<SubmitOutcome> {
      const outcome = await tasks.submit({ ...command, pixels: [] })
      if (outcome.kind === 'created' && command.pixels.length > 0) {
        await pixels.putMany(outcome.id, command.pixels)
      }
      return outcome
    },
    async completeWithPixels(
      id: string,
      resultPayload: unknown,
      objects: readonly NewPixelObject[],
      completedAt: number,
    ): Promise<boolean> {
      if (objects.length > 0) await pixels.putMany(id, objects)
      return tasks.tasks.complete(id, resultPayload, completedAt)
    },
  }
}
