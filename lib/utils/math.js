// From https://stackoverflow.com/a/20811670
export function filterOutliers (source, f1 = 0.25, f2 = 1.5) {
  const values = source.slice().sort((a, b) => a - b)

  // Then find a generous IQR. This is generous because if (values.length / 4)
  // is not an int, then really you should average the two elements on either
  // side to find q1 and q3
  const q1 = values[Math.floor(values.length * f1)]
  const q3 = values[Math.ceil(values.length * (1 - f1))]
  const iqr = q3 - q1

  // Then find min and max values
  const maxValue = q3 + iqr * f2
  const minValue = q1 - iqr * f2

  // Then filter anything beyond or beneath these values.
  return values.filter(x => (x <= maxValue) && (x >= minValue))
}

export function getStandardDeviation (array) {
  const n = array.length
  if (n === 0) { return NaN }
  const mean = array.reduce((a, b) => a + b) / n
  return Math.sqrt(array.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n)
}
