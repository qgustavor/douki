# Deno version

This directory contains a port of Douki using Deno instead of Node.js.

That's in order to test if using Deno would be better than Node for this project and it might not be updated anymore in case Node is chosen. Using Deno would allow easily compilation to executables and allow quickly making a CLI without requiring to install any modules. Node could still be supported using [dnt](https://github.com/denoland/dnt).

## Usage

1. Get [Deno](https://deno.land/#installation)
2. Get [ffmpeg](https://ffmpeg.org/download.html)
3. Run `deno run -A https://raw.githubusercontent.com/qgustavor/douki/main/deno/cli.ts`

There are two subcommands:

### generate-sync-data

```bash
deno run -A path/to/cli.ts generate-sync-data video.mkv
```

Will generate synchronization data for the source file.

It accepts the following options:

```
-n, --name   [string]  - Name of the section (default: auto numbered)
-d, --dir    [string]  - Directory to store synchronization data (default: current directory)
-s, --start  [string]  - Timestamp of the start of the section (default: 0)
-t, --end    [string]  - Timestamp of the end of the section (default: the end of the file)
--template   [file]    - A file to be used as template
```

Example:

``` bash
# Takes episode-02.mkv, splits from 1:00 to 2:30 and generates synchronization
# files from it named opening.json and opening.ass in the current directory
deno run -A path/to/cli.ts generate-sync-data episode-02.mkv -s 1:00 -t 2:30 -n opening`

# Takes ending.mkv and generates synchronization files from it named ending.json
# and ending.ass in the "test-project" directory using template.ass as a template
deno run -A path/to/cli.ts generate-sync-data ending.mkv -n ending -d test-project --template template.ass`
```

That command must be run for each section that needs to be synchronized (like an opening and an ending). After running that command edit the generated .ass file as needed. If the source file already had a subtitle it will be used, otherwise the template will be used, but if no template was specified then no subtitle will be generated and you will need to create one.

### generate-subtitles

```bash
deno run -A path/to/cli.ts generate-subtitles video.mkv
```

It will taking the audio from the file passed as argument, match it against the existent synchronization data, for each match it will synchronize the matched subtitle with the file - cutting it if needed - and generate a new subtitle containing the synchronized sections.

It accepts the following options:

```
-s, --source-dir  - Directory with synchronization data (default: current directory)
-t, --target-dir  - Directory to store generated subtitle (default: current directory)
```


Example:

``` bash
# Takes episode-10.mkv and matches synchronization data from the current directory, then
# if the audio matches, it will create a .synced.ass file with the synchronized subtitles
deno run -A path/to/cli.ts generate-subtitles episode-10.mkv

# Like above, but read synchronization data from "test-project" directory
deno run -A path/to/cli.ts generate-subtitles episode-10.mkv --source-dir test-project

# Like above, but write the subtitle to the "output" directory
deno run -A path/to/cli.ts generate-subtitles episode-10.mkv --target-dir output
```

## Programmatic API

The programmatic is the same as the Node one:

```javascript
import { generateSyncData, synchronizeSubtitles } from 'https://raw.githubusercontent.com/qgustavor/douki/main/deno/mod.ts'

await generateSyncData(options)
await synchronizeSubtitles(options)
```

For more info about the programmatic check [the Node readme](https://github.com/qgustavor/douki#usage).
