const MASKED_OUTPUT_ERROR_TAG = Symbol.for('image-playground.masked-output-error')

export class MaskedOutputError extends Error {
  readonly [MASKED_OUTPUT_ERROR_TAG] = true
}
