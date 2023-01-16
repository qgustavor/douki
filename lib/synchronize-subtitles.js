import Fingerprinter from '@qgustavor/stream-audio-fingerprint'
import stringify from '@qgustavor/ass-stringify'
import parse from '@qgustavor/ass-parser'
import path from 'path'
import fs from 'fs'
import { filterOutliers, getStandardDeviation } from './utils/math.js'
import { extractFingerprints } from './utils/ffmpeg.js'

export default async function (filePath, syncFolder, target, options = {}) {
  const log = options.log || console.log.bind(console)
  const fingerprinter = new Fingerprinter()
  const haystackFingerprints = await extractFingerprints(filePath, fingerprinter)
  const [syncedSubtitles, attachments] = await loadSynchronizationData(syncFolder)

  const validSyncedSubtitles = getSynchronizationDelays(haystackFingerprints, syncedSubtitles, fingerprinter)
  if (validSyncedSubtitles.length === 0) return

  for (const syncData of validSyncedSubtitles) {
    log(
      syncData.subtitlePath.substr(65),
      'from', syncData.from.toFixed(3),
      'to', syncData.to.toFixed(3),
      'got', syncData.count, 'matches in',
      syncData.delay.toFixed(3),
      'with deviation',
      syncData.deviation
    )
  }

  const mainScript = validSyncedSubtitles[0]
  const data = await fs.promises.readFile(mainScript.subtitlePath, 'utf-8')
  const parsed = parse(data, { parseTimestamps: true })
  const eventsSection = parsed.find(e => e.section === 'Events')
  const styleSection = parsed.find(e => e.section.includes('Styles'))

  const delayedMainEvents = eventsSection.body.filter(e => e.key === 'Dialogue')
  for (const event of delayedMainEvents) {
    const startTime = event.value.Start
    const endTime = event.value.End
    const newStartTime = startTime + mainScript.delay
    const newEndTime = endTime + mainScript.delay

    if (startTime > mainScript.to || endTime < mainScript.from || newEndTime < 0) {
      event.deleted = true
    } else {
      event.value.Start = Math.max(0, newStartTime)
      event.value.End = newEndTime
    }
  }

  const extraScripts = validSyncedSubtitles.slice(1)
  for (const syncData of extraScripts) {
    const data = await fs.promises.readFile(syncData.subtitlePath, 'utf-8')
    const { delay, from, to } = syncData
    const extraScript = parse(data, { parseTimestamps: true })
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
      const startTime = event.value.Start
      const endTime = event.value.End
      if (startTime > to || endTime < from) {
        event.deleted = true
      }
      event.value.Start = startTime + delay
      event.value.End = endTime + delay
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

  let subtitle
  if (target.includes('.ass')) {
    subtitle = target
  } else {
    const subtitleId = Math.random().toString(36).substr(2)
    const subtitleName = subtitleId + '.synced.ass'
    subtitle = path.resolve(target, subtitleName)
  }
  const subtitleData = stringify(parsed)
  await fs.promises.writeFile(subtitle, subtitleData)

  return { subtitle, attachments, syncedSubtitles }
}

export async function loadSynchronizationData (syncFolder) {
  const syncedSubtitles = []
  const attachments = []

  const syncFiles = await fs.promises.readdir(syncFolder)
  const syncFingerprints = syncFiles.filter(e => e.endsWith('.json'))

  for (const fingerFilename of syncFingerprints) {
    const fingerPath = path.resolve(syncFolder, fingerFilename)
    const subtitlePath = path.resolve(syncFolder, fingerFilename.replace('.json', '.ass'))
    const attachmentsPath = path.resolve(syncFolder,
      fingerFilename.replace('.json', '-attachments')
    )
    const fingerAttachments = await fs.promises.readdir(attachmentsPath).catch(() => [])
    for (const file of fingerAttachments) {
      attachments.push(path.resolve(attachmentsPath, file))
    }

    const fingerprints = JSON.parse(await fs.promises.readFile(fingerPath, 'utf-8'))
    syncedSubtitles.push({ fingerprints, subtitlePath })
  }

  return [syncedSubtitles, attachments]
}

export function getSynchronizationDelays (haystackFingerprints, syncedSubtitles, fingerprinter) {
  const timingFactor = fingerprinter.options.dt
  const validSubtitles = []

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
    let filteredDelays
    let stdDeviation

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

      validSubtitles.push({
        ...syncData,
        delay: correctedDelay,
        from: minMatchedTime,
        to: maxMatchedTime,
        count: filteredCount,
        deviation: stdDeviation
      })
    }
  }

  return validSubtitles
}
