import { generateSyncData, synchronizeSubtitles } from './mod.ts'
import { Command } from 'https://deno.land/x/cliffy/command/mod.ts'
import { colors } from 'https://deno.land/x/cliffy@v0.24.3/ansi/colors.ts'
import pkg from '../package.json' assert { type: 'json' }

const command = new Command()
  // Main command.
  .name('douki')
  .version(pkg.version)
  .description(pkg.description)
  .action(() => {
    console.log(colors.bold.red('Welcome to Douki!'))
    command.showHelp()
    console.log('Run generate-sync-data subcommand to begin.')
  })

  // generate-sync-data
  .command('generate-sync-data', 'Generate synchronization data from a section of audio or video')
  .option('-n, --name [string]', 'Name of the section (default: auto numbered)')
  .option('-d, --dir [string]', 'Directory to store synchronization data (default: current directory)')
  .option('-s, --start [string]', 'Timestamp of the start of the section (default: 0)')
  .option('-t, --end [string]', 'Timestamp of the end of the section (default: the end of the file)')
  .option('--template [file]', 'A .ass file to be used as template for the subtitle')
  .arguments('<source:string>')
  .action(async (options, source: string) => {
    const dataDir = options.dir ?? Deno.cwd()
    await generateSyncData({
      // Path to audio or video file containing the section to be synchronized
      sourceFile: source,
      // Directory where the synchronization data will be stored
      // (a single directory can store data from multiple sections from the same project)
      dataDir,
      // The start and end times of the section (optional)
      // Can be a seconds number or a 00:00.00 timestamp string
      start: options.start,
      end: options.end,
      // Name of the section (optional)
      name: options.name,
      // A .ass file to be used as template (optional)
      templatePath: options.template
    })

    console.log(`Synchronization data generated! Open ${dataDir} to edit the subtitle. After than run the generate-subtitles subcommand to generate new subtitles synchronized on new audio files.`)
  })

  // generate-subtitles
  .command('generate-subtitles', 'Synchronize subtitles to a new audio')
  .option('-s, --source-dir', 'Directory with synchronization data (default: current directory)')
  .option('-t, --target-dir', 'Directory to store generated subtitle (default: current directory)')
  .arguments('<source:string>')
  .action(async (options, source: string) => {
    const result = await synchronizeSubtitles(
      // Path to the new video or audio file to sync subtitles against
      source,
      // Path to the directory where synchronization data was stored
      options.sourceDir ?? Deno.cwd(),
      // Path to the directory generated files will be stored
      options.targetDir ?? Deno.cwd()
    )

    if (!result) {
      console.log('No matches found')
      return
    }

    console.log(`Subtitle written to ${result.subtitle}`)
    if (result.attachments.length) {
      console.log(`Include the following files when muxing the video:\n${result.attachments.join('\n')}`)
    }
  })

await command.parse()
