import settings from './masked-edit.config.json'

for (const [key, names] of Object.entries({
  output: ['dimensionMultiple', 'maxEdge', 'maxAspectRatio', 'minPixels', 'maxPixels'],
  boundary: ['featherPixels', 'minImageEdge'],
  alignment: [
    'gridSize',
    'analysisMaxEdge',
    'minVariance',
    'minCorrelation',
    'minMatchedFraction',
    'maxFlatDifference',
  ],
  regions: ['minPixels', 'changedDelta', 'minChangedFraction', 'maxRetries'],
  rescale: [
    'maxScaleFactor',
    'maxAspectDifference',
    'minTexturedRegions',
    'minMatchedQuadrants',
    'minAllMatchedRegions',
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
    (key) => !['output', 'alignment', 'rescale', 'boundary', 'regions'].includes(key),
  ) ||
  !Number.isInteger(settings.boundary.featherPixels) ||
  settings.boundary.featherPixels > 32 ||
  !Number.isInteger(settings.boundary.minImageEdge) ||
  settings.rescale.maxScaleFactor < 1 ||
  settings.rescale.maxAspectDifference > 1 ||
  !Number.isInteger(settings.rescale.minTexturedRegions) ||
  !Number.isInteger(settings.rescale.minMatchedQuadrants) ||
  settings.rescale.minMatchedQuadrants > 4 ||
  !Number.isInteger(settings.rescale.minAllMatchedRegions) ||
  !Number.isInteger(settings.alignment.gridSize) ||
  settings.alignment.gridSize < 2 ||
  settings.alignment.gridSize > 64 ||
  !Number.isInteger(settings.alignment.analysisMaxEdge) ||
  settings.alignment.analysisMaxEdge < settings.alignment.gridSize * 2 ||
  settings.alignment.minCorrelation > 1 ||
  settings.alignment.minMatchedFraction > 1 ||
  !Number.isInteger(settings.output.dimensionMultiple) ||
  settings.output.minPixels > settings.output.maxPixels ||
  !Number.isInteger(settings.regions.minPixels) ||
  !Number.isInteger(settings.regions.maxRetries) ||
  settings.regions.maxRetries > 3 ||
  settings.regions.changedDelta > 255 ||
  settings.regions.minChangedFraction > 1
)
  throw new Error('Invalid masked edit configuration')
export const maskedEditSettings = settings
