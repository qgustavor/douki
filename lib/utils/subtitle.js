import parse from '@qgustavor/ass-parser'
import stringify from '@qgustavor/ass-stringify'

export function addMetadataToSubtitle (subtitleData, subtitleId, includesVideo) {
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

export function updateSectionValue (section, key, value) {
  const entry = section.body.find(e => e.key === key)
  if (entry) {
    entry.value = value
  } else {
    section.body.push({ key, value })
  }
}

export function removeSectionValue (section, key) {
  const index = section.body.findIndex(e => e.key === key)
  if (index === -1) { return }
  section.body.splice(index, 1)
}
