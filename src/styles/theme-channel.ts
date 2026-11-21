import { APPEARANCES, applyAppearance } from './appearance'
// Only public appearance preset names are sent between application windows.
const channel = new BroadcastChannel('paperfeed-window-theme')
channel.onmessage = ({ data }) => {
  const preset = APPEARANCES.find(p => p.key === data?.appearance)
  if (preset) applyAppearance(preset)
}
export function broadcastAppearance(key: string) {
  const preset = APPEARANCES.find(p => p.key === key)
  if (preset) {
    applyAppearance(preset)
    channel.postMessage({ appearance: key })
  }
}
