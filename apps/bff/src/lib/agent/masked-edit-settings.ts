import settings from './masked-edit.config.json'

for (const [key, names] of Object.entries({
  output: ['dimensionMultiple', 'maxEdge', 'maxAspectRatio', 'minPixels', 'maxPixels'],
  boundary: ['featherPixels', 'minImageEdge'],
  alignment: [
    'gridSize',
    'minVariance',
    'minCorrelation',
    'minMatchedFraction',
    'maxFlatDifference',
  ],
  rescale: [
    'maxScaleDifference',
    'maxAspectDifference',
    'minTexturedRegions',
    'minMatchedQuadrants',
  ],
})) {
  const group = settings[key as keyof typeof settings]
  if (
    Object.keys(group).some((name) => !names.includes(name)) ||
    names.some(
      (name) =>
        typeof (group as Record<string, number>)[name] !== 'number' ||
        !Number.isFinite((group as Record<string, number>)[name]) ||
        (group as Record<string, number>)[name]! <= 0,
    )
  )
    throw new Error('Invalid masked edit configuration')
}
if (
  Object.keys(settings).some(
    (key) => !['output', 'alignment', 'rescale', 'boundary'].includes(key),
  ) ||
  !Number.isInteger(settings.boundary.featherPixels) ||
  settings.boundary.featherPixels > 32 ||
  !Number.isInteger(settings.boundary.minImageEdge) ||
  settings.rescale.maxScaleDifference > 1 ||
  settings.rescale.maxAspectDifference > 1 ||
  !Number.isInteger(settings.rescale.minTexturedRegions) ||
  !Number.isInteger(settings.rescale.minMatchedQuadrants) ||
  settings.rescale.minMatchedQuadrants > 4 ||
  !Number.isInteger(settings.alignment.gridSize) ||
  settings.alignment.gridSize < 2 ||
  settings.alignment.gridSize > 64 ||
  settings.alignment.minCorrelation > 1 ||
  settings.alignment.minMatchedFraction > 1 ||
  !Number.isInteger(settings.output.dimensionMultiple) ||
  settings.output.minPixels > settings.output.maxPixels
)
  throw new Error('Invalid masked edit configuration')
export const maskedEditSettings = settings
