export function parseTimestamp (timestamp) {
  return timestamp
    .toString()
    .split(':')
    .reduce((sum, e) => sum * 60 + Number(e), 0)
}

export function formatTimestamp (timestamp) {
  return new Date(Math.max(0, timestamp * 1000))
    .toISOString()
    .substring(11, 22)
    .replace(/^0/, '')
}
