import { parseTimestamp, formatTimestamp } from './utils/timestamp.js'
import Fingerprinter from 'https://cdn.skypack.dev/@qgustavor/stream-audio-fingerprint'
import stringify from 'https://cdn.skypack.dev/@qgustavor/ass-stringify'
import parse from 'https://cdn.skypack.dev/@qgustavor/ass-parser'
import * as path from 'https://deno.land/std@0.151.0/node/path/mod.ts'

export default async function (filePath, syncFolder, targetFolder) {
  const attachments = []
  const syncFingerprints = []
  for await (const { name } of Deno.readDir(syncFolder)) {
    if (name.endsWith('.json')) {
      syncFingerprints.push(name)
    }
  }

  const fingerprinter = new Fingerprinter()
  const decoder = Deno.run({
    cmd: [
      'ffmpeg',
      '-i', filePath,
      '-acodec', 'pcm_s16le',
      '-ar', 22050,
      '-ac', 1,
      '-f', 'wav',
      '-v', 'fatal',
      'pipe:1'
    ],
    stdin: 'null',
    stderr: 'null',
    stdout: 'piped'
  })

  const haystackFingerprints = []
  for await (const audioData of decoder.stdout.readable) {
    const data = fingerprinter.process(audioData)
    for (let i = 0; i < data.tcodes.length; i++) {
      haystackFingerprints.push([
        data.tcodes[i], data.hcodes[i]
      ])
    }
  }
  await decoder.status()

  let syncedSubtitles = []
  for (const fingerFilename of syncFingerprints) {
    const fingerPath = path.resolve(syncFolder, fingerFilename)
    const subtitlePath = path.resolve(syncFolder, fingerFilename.replace('.json', '.ass'))
    const attachmentsPath = path.resolve(syncFolder,
      fingerFilename.replace('.json', '-attachments')
    )
    try {
      for await (const file of Deno.readDir(attachmentsPath)) {
        attachments.push(path.resolve(attachmentsPath, file.name))
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    const fingerprints = JSON.parse(await Deno.readTextFile(fingerPath))
    syncedSubtitles.push({ fingerprints, subtitlePath })
  }

  const timingFactor = fingerprinter.options.dt
  for (const syncData of syncedSubtitles) {
    const matchData = syncData.fingerprints.map(needleFP => [
      needleFP[0],
      haystackFingerprints
        .filter(hayFP => hayFP[1] === needleFP[1])
        .map(e => e[0] - needleFP[0])
    ]).filter(e => e[1].length !== 0)

    // Filter multiple matches by checking the previous entry
    for (let i = 0; i < matchData.length; i++) {
      if (matchData[i][1].length === 1) continue
      const lastValue = i === 0 ? 0 : matchData[i - 1][1][0]
      const closestPoint = matchData[i][1].map(e => [
        e, Math.abs(e - lastValue)
      ]).sort((a, b) => a[1] - b[1])[0][0]
      matchData[i][1] = [closestPoint]
    }

    // Get delays and filter outliers to avoid false positives
    const delays = matchData.map(e => e[1][0])
    const minimalMatchCount = 10
    const maxAllowedDeviation = 750
    const maxTargettedDeviation = 200

    let filteredDelays, stdDeviation
    for (let i = 25; i < 40; i += 5) {
      const filterFactor = i / 100
      const currentFiltered = filterOutliers(delays, filterFactor)
      if (filteredDelays && currentFiltered.length < minimalMatchCount) {
        break
      }
      filteredDelays = currentFiltered
      stdDeviation = filteredDelays.length
        ? getStandardDeviation(filteredDelays)
        : Infinity
      if (stdDeviation < maxTargettedDeviation) break
    }

    const filteredCount = filteredDelays.length
    if (filteredCount > minimalMatchCount && stdDeviation < maxAllowedDeviation) {
      const averageDelay = filteredDelays.reduce((a, b) => a + b) / filteredDelays.length
      const correctedDelay = Math.max(0, averageDelay * timingFactor)
      const matchedTimes = matchData
        .filter(e => filteredDelays.includes(e[1][0]))
        .map(e => e[0])
      const minMatchedTime = matchedTimes.reduce((a, b) => Math.min(a, b)) * timingFactor
      const maxMatchedTime = matchedTimes.reduce((a, b) => Math.max(a, b)) * timingFactor

      console.log(
        syncData.subtitlePath.substr(65),
        'from', minMatchedTime.toFixed(3),
        'to', maxMatchedTime.toFixed(3),
        'got', filteredCount, 'matches in',
        correctedDelay.toFixed(3),
        'with deviation',
        stdDeviation
      )

      syncData.delay = correctedDelay
      syncData.from = minMatchedTime
      syncData.to = maxMatchedTime
    }
  }

  syncedSubtitles = syncedSubtitles.filter(e => e.delay != null)
  if (syncedSubtitles.length === 0) return

  const mainScript = syncedSubtitles[0]
  const data = await Deno.readTextFile(mainScript.subtitlePath)
  const parsed = parse(data)
  const eventsSection = parsed.find(e => e.section === 'Events')
  const styleSection = parsed.find(e => e.section.includes('Styles'))

  const delayedMainEvents = eventsSection.body.filter(e => e.key === 'Dialogue')
  for (const event of delayedMainEvents) {
    const startTime = parseTimestamp(event.value.Start)
    const endTime = parseTimestamp(event.value.End)
    const newStartTime = startTime + mainScript.delay
    const newEndTime = endTime + mainScript.delay

    if (startTime > mainScript.to || endTime < mainScript.from || newEndTime < 0) {
      event.deleted = true
    } else {
      event.value.Start = formatTimestamp(Math.max(0, newStartTime))
      event.value.End = formatTimestamp(newEndTime)
    }
  }

  const extraScripts = syncedSubtitles.slice(1)
  for (const syncData of extraScripts) {
    const data = await Deno.readTextFile(syncData.subtitlePath)
    const { delay, from, to } = syncData
    const extraScript = parse(data)
    const extraStyles = extraScript
      .find(e => e.section.includes('Styles'))
      .body.filter(e => e.key === 'Style')

    const dedupMap = new Map()
    for (const style of extraStyles) {
      const existentStyle = styleSection.body.find(e =>
        e.key === 'Style' && e.value.Name === style.value.Name
      )
      if (existentStyle) {
        const newName = Math.random().toString(16).substr(2, 8)
        dedupMap.set(style.value.Name, newName)
        style.value.Name = newName
      }
    }
    styleSection.body = styleSection.body.concat(extraStyles)

    const extraEvents = extraScript.find(e => e.section === 'Events')
    const delayedEvents = extraEvents.body.filter(e => e.key === 'Dialogue')
    for (const event of delayedEvents) {
      const startTime = parseTimestamp(event.value.Start)
      const endTime = parseTimestamp(event.value.End)
      if (startTime > to || endTime < from) {
        event.deleted = true
      }
      event.value.Start = formatTimestamp(startTime + delay)
      event.value.End = formatTimestamp(endTime + delay)
      const remappedStyle = dedupMap.get(event.value.Style)
      if (remappedStyle) event.value.Style = remappedStyle
    }

    eventsSection.body = eventsSection.body.concat(delayedEvents)
  }

  // Remove filtered events and sort those
  eventsSection.body = eventsSection.body
    .filter(e => !e.deleted)
    .sort((a, b) => {
      if (a.key !== 'Dialogue') return -1
      if (b.key !== 'Dialogue') return 1
      return a.value.Start.localeCompare(b.value.Start)
    })

  const subtitleId = Math.random().toString(36).substr(2)
  const subtitleName = subtitleId + '.synced.ass'
  const subtitle = path.resolve(targetFolder, subtitleName)
  const subtitleData = stringify(parsed)
  await Deno.writeTextFile(subtitle, subtitleData)

  return { subtitle, attachments }
}

// From https://stackoverflow.com/a/20811670
function filterOutliers (source, f1 = 0.25, f2 = 1.5) {
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

function getStandardDeviation (array) {
  const n = array.length
  if (n === 0) return NaN
  const mean = array.reduce((a, b) => a + b) / n
  return Math.sqrt(array.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n)
}
