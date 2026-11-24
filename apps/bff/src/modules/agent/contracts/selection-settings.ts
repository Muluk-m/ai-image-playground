import settings from './selection.config.json'

if (
  !Number.isSafeInteger(settings.maxPixels) ||
  settings.maxPixels <= 0 ||
  Object.keys(settings).some((key) => key !== 'maxPixels')
)
  throw new Error('Invalid selection pixel budget')

export const selectionSettings = settings
