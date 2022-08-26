import cp from 'child_process'

export async function getVideoScenes (videoPath, sceneFactor = 0.15) {
  const sceneDetectProcess = cp.spawn('ffmpeg', [
    '-i', videoPath,
    '-filter:v', `select='gt(scene,${sceneFactor})',showinfo`,
    '-f', 'null',
    '-'
  ], {
    stdio: ['ignore', 'ignore', 'pipe']
  })

  let sceneDetectData = ''
  sceneDetectProcess.stderr.on('data', e => { sceneDetectData += e })
  await new Promise((resolve, reject) => {
    sceneDetectProcess.on('exit', code => {
      if (code === 0) { return resolve() }
      reject(Error('scene ffmpeg exited with ' + code))
    })
  })

  const sceneTimestamps = sceneDetectData.split('\n')
    .filter(e => e.includes('pts_time'))
    .map(e => Number(e.match(/pts_time:(\d+\.?\d*)/)[1]))

  return sceneTimestamps
}

export async function getVideoFps (videoPath) {
  const sceneFpsProcess = cp.spawn('ffprobe', [
    '-skip_frame', 'nokey',
    '-select_streams', 'v',
    '-show_streams',
    '-show_entries', 'stream=avg_frame_rate',
    '-of', 'json',
    videoPath
  ], {
    stdio: ['ignore', 'pipe', 'ignore']
  })

  let sceneFpsData = ''
  sceneFpsProcess.stdout.on('data', e => {
    sceneFpsData += e
  })
  await new Promise((resolve, reject) => {
    sceneFpsProcess.on('exit', code => {
      if (code === 0) { return resolve() }
      reject(Error('scene ffprobe exited with ' + code))
    })
  })
  const sceneFps = JSON.parse(sceneFpsData)
    .streams[0].avg_frame_rate
    .split('/').reduce((a, b) => a / b)
  return sceneFps
}

export async function extractFingerprints (audioPath, fingerprinter) {
  const decoder = cp.spawn('ffmpeg', [
    '-i', audioPath,
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

  return fingerprints
}

export async function extractKeyframes (sourceFile, parsedStart = 0) {
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

  let keyframes = ''
  keyframeProcess.stdout.on('data', e => { keyframes += e })
  await new Promise((resolve, reject) => {
    keyframeProcess.on('exit', code => {
      if (code === 0) { return resolve() }
      reject(Error('keyframe ffprobe exited with ' + code))
    })
  })
  keyframes = JSON.parse(keyframes)?.frames
    .map(e => Number(e.best_effort_timestamp_time))
    .filter(e => !Number.isNaN(e))
  return keyframes
}

export function runFfmpeg (argv, options) {
  return new Promise((resolve, reject) => {
    const ffmpegProcess = cp.spawn('ffmpeg', argv, options)
    ffmpegProcess.once('error', reject)
    ffmpegProcess.once('close', resolve)
  })
}
