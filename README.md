![Douki logo](https://i.imgur.com/VIBFtEr.png)

Douki is a audio fingerprinting based subtitle synchronization tool.

> **Douki** (同期): synchronization  
> -- [Jisho](https://jisho.org/word/%E5%90%8C%E6%9C%9F)

This project started in ‎October ‎2020 and was made to automatically synchronize song translations in anime. It was been already tested with dozens of anime, including Douki-chan.

At the moment only a programmatic API is available. Check the roadmap [in the respective GitHub issue](https://github.com/qgustavor/douki/issues/1).

## Usage

Make sure [ffmpeg](https://ffmpeg.org/) is installed and available in the path.

Generate synchronization data by running this:

```javascript
import { generateSyncData } from 'douki'

await generateSyncData({
  // Path to audio or video file containing the section to be synchronized
  sourceFile: 'Test - Episode 2.mkv',
  // Directory where the synchronization data will be stored
  // (a single directory can store data from multiple sections from the same project)
  dataDir: 'projects/test',
  // The start and end times of the section (optional)
  // Can be a seconds number or a 00:00.00 timestamp string
  start: 0,
  end: 90,
  // Name of the section (optional)
  name: 'opening',
  // A .ass file to be used as template (optional)
  templatePath: 'template.ass'
})
```

By running the above code it will create a `.json` file containing synchronization data, a `.mkv` containing the synchronized section, a subdirectory containing attachments found in the source file, an `.ass` file with the subtitle found in the source file or, if there was not any, based in the template, and a `keyframes.txt` file.

Edit the `.ass` as needed. It should be timed against the `.mkv` file. Run the above code multiple times for each section to be synchronized. The `.mkv` and `keyframes.txt` files are meant only to aid editing the `.ass` file and can be deleted afterwards.

Run the below code to synchronize the section to another files:

```js
import { synchronizeSubtitles } from 'douki'

const result = await synchronizeSubtitles(
  // Path to the new video or audio file to sync subtitles against
  'Test - Episode 3.mkv',
  // Path to the directory where synchronization data was stored
  'projects/test',
  // Path to the directory generated files will be stored
  'some/temporary/dir'
)

// The path to the generated subtitle
console.log(result.subtitle)

// An array of paths of the files that need to be
// attached along the generated subtitle
console.log(result.attachments)

// synchronizeSubtitles will return undefined when there are no matches
```

You can use a player that natively supports multiple subtitles at the same time (like MX Player, which is the player it was been mostly tested on) or use [a MPV fork](https://github.com/mpv-player/mpv/issues/3022#issue-145555437) that enables support to multiple subtitles or find a way to merge the generated subtitles with existent ones.
