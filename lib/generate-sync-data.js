import { parseTimestamp } from './utils/timestamp.js'
import Fingerprinter from '@qgustavor/stream-audio-fingerprint'
import stringify from '@qgustavor/ass-stringify'
import parse from '@qgustavor/ass-parser'
import cp from 'child_process'
import path from 'path'
import fs from 'fs'

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
    // List video keyframes
    const keyframeProcess = cp.spawn('ffprobe', [
      '-skip_frame', 'nokey',
      '-select_streams', 'v',
      '-show_frames',
      '-show_entries', 'frame=best_effort_timestamp_time',
      '-read_intervals', Math.floor(parsedStart - 30) + '%+60',
      '-of', 'json',
      sourceFile
    ], {
      stdio: ['ignore', 'pipe', 'ignore']
    })

    keyframes = ''
    keyframeProcess.stdout.on('data', e => { keyframes += e })
    await new Promise((resolve, reject) => {
      keyframeProcess.on('exit', code => {
        if (code === 0) return resolve()
        reject(Error('keyframe ffprobe exited with ' + code))
      })
    })
    keyframes = JSON.parse(keyframes)?.frames
      .map(e => Number(e.best_effort_timestamp_time))
      .filter(e => !Number.isNaN(e))
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
  const fingerprinter = new Fingerprinter()
  const decoder = cp.spawn('ffmpeg', [
    '-i', croppedPath,
    '-acodec', 'pcm_s16le',
    '-ar', 22050,
    '-ac', 1,
    '-f', 'wav',
    '-v', 'fatal',
    'pipe:1'
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const fingerprints = []
  decoder.stdout.on('data', audioData => {
    const data = fingerprinter.process(audioData)
    for (let i = 0; i < data.tcodes.length; i++) {
      fingerprints.push([data.tcodes[i], data.hcodes[i]])
    }
  })
  await new Promise(resolve => decoder.on('close', resolve))
  const fingerprintsPath = path.resolve(dataDir, subtitleId + '.json')
  await fs.promises.writeFile(fingerprintsPath, JSON.stringify(fingerprints))

  if (includesVideo) {
    // Extract detailed video keyframes
    const sceneFpsProcess = cp.spawn('ffprobe', [
      '-skip_frame', 'nokey',
      '-select_streams', 'v',
      '-show_streams',
      '-show_entries', 'stream=avg_frame_rate',
      '-of', 'json',
      croppedPath
    ], {
      stdio: ['ignore', 'pipe', 'ignore']
    })

    let sceneFpsData = ''
    sceneFpsProcess.stdout.on('data', e => {
      sceneFpsData += e
    })
    await new Promise((resolve, reject) => {
      sceneFpsProcess.on('exit', code => {
        if (code === 0) return resolve()
        reject(Error('scene ffprobe exited with ' + code))
      })
    })
    const sceneFps = JSON.parse(sceneFpsData)
      .streams[0].avg_frame_rate
      .split('/').reduce((a, b) => a / b)

    const sceneDetectProcess = cp.spawn('ffmpeg', [
      '-i', croppedPath,
      '-filter:v', "select='gt(scene,0.15)',showinfo",
      '-f', 'null',
      '-'
    ], {
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let sceneDetectData = ''
    sceneDetectProcess.stderr.on('data', e => { sceneDetectData += e })
    await new Promise((resolve, reject) => {
      sceneDetectProcess.on('exit', code => {
        if (code === 0) return resolve()
        reject(Error('scene ffmpeg exited with ' + code))
      })
    })

    const sceneTimestamps = sceneDetectData.split('\n')
      .filter(e => e.includes('pts_time'))
      .map(e => Number(e.match(/pts_time:(\d+\.?\d*)/)[1]))

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

function runFfmpeg (argv, options) {
  return new Promise((resolve, reject) => {
    const ffmpegProcess = cp.spawn('ffmpeg', argv, options)
    ffmpegProcess.once('error', reject)
    ffmpegProcess.once('close', resolve)
  })
}

function addMetadataToSubtitle (subtitleData, subtitleId, includesVideo) {
  const parsedSubtitle = parse(subtitleData)

  // Update the subtitle name with the subtitle id
  const infoSection = parsedSubtitle.find(e => e.section === 'Script Info')
  if (infoSection) {
    updateSectionValue(infoSection, 'Title', subtitleId)
  }

  // Create the Aegisub metadata if it not exists
  let aegisubSection = parsedSubtitle.find(e => e.section === 'Aegisub Project Garbage')
  if (!aegisubSection) {
    aegisubSection = {
      section: 'Aegisub Project Garbage',
      body: []
    }
    parsedSubtitle.splice(1, 0, aegisubSection)
  }

  // Update the metadata to point to the generated files
  updateSectionValue(aegisubSection, 'Audio File', `${subtitleId}.mkv`)
  if (includesVideo) {
    updateSectionValue(aegisubSection, 'Video File', `${subtitleId}.mkv`)
    updateSectionValue(aegisubSection, 'Keyframes File', `${subtitleId}-keyframes.txt`)
  } else {
    removeSectionValue(aegisubSection, 'Video File')
    removeSectionValue(aegisubSection, 'Keyframes File')
  }
  removeSectionValue(aegisubSection, 'Video AR Value')
  removeSectionValue(aegisubSection, 'Video Zoom Percent')
  removeSectionValue(aegisubSection, 'Active Line')
  removeSectionValue(aegisubSection, 'Video Position')

  return stringify(parsedSubtitle)
}

function updateSectionValue (section, key, value) {
  const entry = section.body.find(e => e.key === key)
  if (entry) {
    entry.value = value
  } else {
    section.body.push({ key, value })
  }
}

function removeSectionValue (section, key) {
  const index = section.body.findIndex(e => e.key === key)
  if (index === -1) return
  section.body.splice(index, 1)
}
