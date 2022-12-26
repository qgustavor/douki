import { parseTimestamp } from './utils/timestamp.js'
import Fingerprinter from 'https://cdn.skypack.dev/@qgustavor/stream-audio-fingerprint'
import stringify from 'https://cdn.skypack.dev/@qgustavor/ass-stringify'
import parse from 'https://cdn.skypack.dev/@qgustavor/ass-parser'
import * as path from 'https://deno.land/std@0.151.0/node/path/mod.ts'

export default async function (data) {
  const { sourceFile, subtitleFile, start, end, name, dataDir, templatePath } = data
  const parsedStart = start ? parseTimestamp(start) : 0

  // Create data directory if not exists
  const existingFiles = []
  try {
    for await (const { name } of Deno.readDir(dataDir)) {
      existingFiles.push(name)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await Deno.mkdir(dataDir)
  }
  
  const subtitleId = name || existingFiles
    .filter(e => e.endsWith('.json'))
    .reduce((sum, e) => {
      return Math.max(sum, Number(e.replace(/\D+/g, '')))
    }, 0) + 1

  const sourceInfoProcess = Deno.run({
    cmd: [
      'ffprobe',
      '-show_streams',
      '-show_format',
      '-print_format', 'json',
      sourceFile
    ],
    stdin: 'null',
    stderr: 'null',
    stdout: 'piped'
  })

  let sourceInfo = ''
  const textDecoder = new TextDecoder()
  for await (const chunk of sourceInfoProcess.stdout.readable) {
    sourceInfo += textDecoder.decode(chunk)
  }
  
  const sourceInfoStatus = await sourceInfoProcess.status()
  if (sourceInfoStatus.code !== 0) throw Error('audio info ffprobe exited with ' + sourceInfoStatus.code)
  sourceInfo = JSON.parse(sourceInfo)

  const normalizedEnd = end || sourceInfo.format.duration
  const includesVideo = sourceInfo.streams.some(e => e.codec_type === 'video')
  let keyframes = []

  if (includesVideo) {
    // List video keyframes
    const keyframeProcess = Deno.run({
      cmd: [
        'ffprobe',
        '-skip_frame', 'nokey',
        '-select_streams', 'v',
        '-show_frames',
        '-show_entries', 'frame=best_effort_timestamp_time',
        '-read_intervals', Math.floor(parsedStart - 30) + '%+60',
        '-of', 'json',
        sourceFile
      ],
      stdin: 'null',
      stderr: 'null',
      stdout: 'piped'
    })

    keyframes = ''
    for await (const chunk of keyframeProcess.stdout.readable) {
      keyframes += textDecoder.decode(chunk)
    }
    const keyframeProcessStatus = await keyframeProcess.status()
    if (keyframeProcessStatus.code !== 0) throw Error('keyframe ffprobe exited with ' + keyframeProcessStatus.code)
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
  const decoder = Deno.run({
    cmd: [
      'ffmpeg',
      '-i', croppedPath,
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

  const fingerprints = []
  for await (const audioData of decoder.stdout.readable) {
    const data = fingerprinter.process(audioData)
    for (let i = 0; i < data.tcodes.length; i++) {
      fingerprints.push([data.tcodes[i], data.hcodes[i]])
    }
  }
  await decoder.status()
  const fingerprintsPath = path.resolve(dataDir, subtitleId + '.json')
  await Deno.writeTextFile(fingerprintsPath, JSON.stringify(fingerprints))

  if (includesVideo) {
    // Extract detailed video keyframes
    const sceneFpsProcess = Deno.run({
      cmd: [
        'ffprobe',
        '-skip_frame', 'nokey',
        '-select_streams', 'v',
        '-show_streams',
        '-show_entries', 'stream=avg_frame_rate',
        '-of', 'json',
        croppedPath
      ],
      stdin: 'null',
      stderr: 'null',
      stdout: 'piped'
    })

    let sceneFpsData = ''
    for await (const chunk of sceneFpsProcess.stdout.readable) {
      sceneFpsData += textDecoder.decode(chunk)
    }
    const sceneFpsStatus = await sceneFpsProcess.status()
    if (sceneFpsStatus.code !== 0) throw Error('scene ffprobe exited with ' + sceneFpsStatus.code)
    const sceneFps = JSON.parse(sceneFpsData)
      .streams[0].avg_frame_rate
      .split('/').reduce((a, b) => a / b)

    const sceneDetectProcess = Deno.run({
      cmd: [
        'ffmpeg',
        '-i', croppedPath,
        '-filter:v', "select='gt(scene,0.15)',showinfo",
        '-f', 'null',
        '-'
      ],
      stdin: 'null',
      stderr: 'piped',
      stdout: 'null'
    })

    let sceneDetectData = ''
    for await (const chunk of sceneDetectProcess.stderr.readable) {
      sceneDetectData += textDecoder.decode(chunk)
    }
    const sceneDetectStatus = await sceneDetectProcess.status()
    if (sceneDetectStatus.code !== 0) throw Error('scene ffmpeg exited with ' + sceneDetectStatus.code)

    const sceneTimestamps = sceneDetectData.split('\n')
      .filter(e => e.includes('pts_time'))
      .map(e => Number(e.match(/pts_time:(\d+\.?\d*)/)[1]))

    const sceneKeyframes = '# keyframe format v1\r\nfps 0\r\n' + sceneTimestamps.map(e => {
      return Math.round(e * sceneFps)
    }).concat('').join('\r\n')
    await Deno.writeTextFile(path.resolve(dataDir, `${subtitleId}-keyframes.txt`), sceneKeyframes)
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
  let subtitleData = await Deno.readTextFile(subtitlePath).catch(() => '')
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
    await Deno.writeTextFile(subtitlePath, subtitleData)

    // Extract attachments
    const attachmentsPath = path.resolve(dataDir, subtitleId + '-attachments')
    await Deno.mkdir(attachmentsPath).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
    await runFfmpeg([
      '-dump_attachment:t', '', '-i', croppedPath, '-nostdin'
    ], {
      cwd: attachmentsPath
    })
    let hasAttachments = false
    for await (const entry of Deno.readDir(attachmentsPath)) {
      hasAttachments = true
      break
    }
    if (!hasAttachments) await Deno.remove(attachmentsPath)
  } else if (templatePath) {
    const templateData = await Deno.readTextFile(templatePath)
    const subtitleData = addMetadataToSubtitle(templateData, subtitleId, includesVideo)
    await Deno.writeTextFile(subtitlePath, subtitleData)
  }
}

function runFfmpeg (argv, options) {
  const ffmpegProcess = Deno.run({
    cmd: ['ffmpeg', ...argv],
    stdin: 'null',
    stdout: 'null',
    stderr: 'null',
    ...options
  })
  return ffmpegProcess.status()
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
