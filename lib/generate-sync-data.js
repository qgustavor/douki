import parse from '@qgustavor/ass-parser'
import stringify from '@qgustavor/ass-stringify'
import cp from 'child_process'
import fs from 'fs'
import path from 'path'
import { extractFingerprints, extractKeyframes, getVideoFps, getVideoScenes, runFfmpeg } from '../utils/ffmpeg-utils.js'
import { addMetadataToSubtitle } from './subtitle'
import { parseTimestamp } from './timestamp.js'

export default async function (data) {
  const { sourceFile, subtitleFile, start, end, name, dataDir, templatePath } = data
  const parsedStart = start ? parseTimestamp(start) : 0

  // Create data directory if not exists
  const existingFiles = await fs.promises.readdir(dataDir).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return fs.promises.mkdir(dataDir).then(() => [])
  })
  const subtitleId = name || existingFiles
    .filter(e => e.endsWith('.json'))
    .reduce((sum, e) => {
      return Math.max(sum, Number(e.replace(/\D+/g, '')))
    }, 0) + 1

  const sourceInfoProcess = cp.spawn('ffprobe', [
    '-show_streams',
    '-show_format',
    '-print_format', 'json',
    sourceFile
  ], {
    stdio: ['ignore', 'pipe', 'ignore']
  })

  let sourceInfo = ''
  sourceInfoProcess.stdout.on('data', e => { sourceInfo += e })
  await new Promise((resolve, reject) => {
    sourceInfoProcess.on('exit', code => {
      if (code === 0) return resolve()
      reject(Error('audio info ffprobe exited with ' + code))
    })
  })
  sourceInfo = JSON.parse(sourceInfo)

  const normalizedEnd = end || sourceInfo.format.duration
  const includesVideo = sourceInfo.streams.some(e => e.codec_type === 'video')
  let keyframes = []

  if (includesVideo) {
    keyframes = await extractKeyframes(sourceFile, parsedStart)
  }

  // Fix start time based on the closest keyframe
  let fixedStart = start
  let needsReencode = includesVideo

  if (keyframes.length !== 0) {
    let fixedDiff
    ;[fixedStart, fixedDiff] = keyframes
      .map(e => [e, Math.abs(e - parsedStart)])
      .sort((a, b) => a[1] - b[1])[0]
    needsReencode = fixedDiff > 2

    if (needsReencode) {
      console.log('Fixed %s to %s: reencode is needed', parsedStart, fixedStart)
    } else {
      console.log('Fixed %s to %s: reencode is NOT needed', parsedStart, fixedStart)
      const keyframeIndex = keyframes.indexOf(fixedStart)
      const skewedStart = (keyframes[keyframeIndex] * 2 + keyframes[keyframeIndex + 1]) / 3
      fixedStart = skewedStart || (fixedStart + 0.5)
    }
  }

  // Cut video (or audio) from start to end
  const croppedPath = path.resolve(dataDir, subtitleId + '.mkv')
  const ffmpegArgv = needsReencode
    // TODO: find some better way to crop video instead of reencoding or cropping at keyframes
    // Some people put keyframes in really bad points!
    ? [
        '-ss', start, '-to', normalizedEnd, '-i', sourceFile,
        '-map', '0',
        '-avoid_negative_ts', 'make_zero',
        '-codec:a', 'copy',
        '-codec:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '28',
        '-vf', 'scale=-2:480',
        croppedPath,
        '-nostdin'
      ]
    : [
        '-ss', fixedStart.toFixed(5), '-to', normalizedEnd, '-i', sourceFile,
        '-map', '0',
        '-avoid_negative_ts', 'make_zero',
        '-codec', 'copy',
        croppedPath,
        '-nostdin'
      ]

  await runFfmpeg(ffmpegArgv)

  // Extract fingerprints
  const fingerprints = await extractFingerprints(croppedPath)
  const fingerprintsPath = path.resolve(dataDir, subtitleId + '.json')
  await fs.promises.writeFile(fingerprintsPath, JSON.stringify(fingerprints))

  if (includesVideo) {
    // Extract detailed video keyframes
    const sceneFps = await getVideoFps(croppedPath)
    const sceneTimestamps = await getVideoScenes(croppedPath)
    const sceneKeyframes = '# keyframe format v1\r\nfps 0\r\n' + sceneTimestamps.map(e => {
      return Math.round(e * sceneFps)
    }).concat('').join('\r\n')

    await fs.promises.writeFile(path.resolve(dataDir, `${subtitleId}-keyframes.txt`), sceneKeyframes)
  }

  // Cut subtitle from start to end
  const subtitlePath = path.resolve(dataDir, subtitleId + '.ass')
  if (subtitleFile) {
    await runFfmpeg([
      '-i', subtitleFile, '-ss', fixedStart, '-to', normalizedEnd,
      '-map', '0', subtitlePath, '-nostdin'
    ])
  } else {
    await runFfmpeg([
      '-i', croppedPath, subtitlePath, '-nostdin'
    ])
  }

  // Use the template if there is less than 10 dialogue lines in the subtitle
  let subtitleData = await fs.promises.readFile(subtitlePath, 'utf-8').catch(() => '')
  let gotValidSubtitle = !!subtitleData

  if (gotValidSubtitle) {
    const subtitleDuration = parseTimestamp(normalizedEnd) - parsedStart
    const parsedSubtitle = parse(subtitleData)
    const eventsSection = parsedSubtitle.find(e => e.section === 'Events')

    if (eventsSection) {
      eventsSection.body = eventsSection.body.filter(e => {
        return e.key === 'Format' || (
          e.key === 'Dialogue' &&
          parseTimestamp(e.value.Start) < subtitleDuration
        )
      })
      subtitleData = stringify(parsedSubtitle)
      gotValidSubtitle = eventsSection.body.length > 11
    } else {
      gotValidSubtitle = false
    }
  }

  if (gotValidSubtitle) {
    subtitleData = addMetadataToSubtitle(subtitleData, subtitleId, includesVideo)
    await fs.promises.writeFile(subtitlePath, subtitleData)

    // Extract attachments
    const attachmentsPath = path.resolve(dataDir, subtitleId + '-attachments')
    await fs.promises.mkdir(attachmentsPath).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
    await runFfmpeg([
      '-dump_attachment:t', '', '-i', croppedPath, '-nostdin'
    ], {
      cwd: attachmentsPath
    })
    const attachmentsList = await fs.promises.readdir(attachmentsPath)
    if (attachmentsList.length === 0) await fs.promises.rmdir(attachmentsPath)
  } else if (templatePath) {
    const templateData = await fs.promises.readFile(templatePath, 'utf-8')
    const subtitleData = addMetadataToSubtitle(templateData, subtitleId, includesVideo)
    await fs.promises.writeFile(subtitlePath, subtitleData)
  }
}
