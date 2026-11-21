
export const APPEARANCES = [
  { key: 'graphite', name: '石墨', desc: '深色实底 · 低对比边框', theme: 'dark', material: 'solid', panel: '#090a0b', reading: '#151618', ink: '#e8e9eb' },
  { key: 'smoke', name: '烟色玻璃', desc: '深色磨砂 · 细亮边缘', theme: 'dark', material: 'smoked', panel: '#303236', reading: '#222325', ink: '#e8e9eb' },
  { key: 'light', name: '素白', desc: '浅色实底 · 清晰阅读', theme: 'light', material: 'solid', panel: '#f2f4f6', reading: '#ffffff', ink: '#252a30' },
  { key: 'frost', name: '霜白', desc: '浅色磨砂 · 柔和层次', theme: 'light', material: 'frosted', panel: '#dce5e5', reading: '#ffffff', ink: '#252a30' },
  { key: 'paper', name: '纸色', desc: '暖色纸感 · 细微纹理', theme: 'paper', material: 'paper', panel: '#f3efe7', reading: '#fffaf0', ink: '#352d24' },
  { key: 'midnight', name: '午夜', desc: '蓝黑实底 · 低亮度', theme: 'midnight', material: 'solid', panel: '#070a19', reading: '#0c1224', ink: '#ecf2ff' },
  { key: 'forest', name: '森林', desc: '墨绿实底 · 柔和文字', theme: 'forest', material: 'solid', panel: '#0a120e', reading: '#0d1812', ink: '#ebfcf1' },
  { key: 'rose', name: '暮色', desc: '暖灰紫实底 · 安静阅读', theme: 'rose', material: 'solid', panel: '#1c0f18', reading: '#24141e', ink: '#fff1f6' },
] as const
export type Appearance = typeof APPEARANCES[number]
export function getAppearance(settings: Record<string, string>): Appearance {
  const saved = APPEARANCES.find(p => p.key === settings.appearance)
  if (saved) return saved
  // Existing combinations are displayed as the closest coherent preset.
  // In particular a light/paper reading area never inherits a dark glass header.
  if (settings.theme === 'light') return APPEARANCES.find(p => p.key === (settings.material === 'frosted' ? 'frost' : 'light'))!
  if (['paper', 'midnight', 'forest', 'rose'].includes(settings.theme)) return APPEARANCES.find(p => p.key === settings.theme)!
  return APPEARANCES.find(p => p.key === (settings.material === 'smoked' ? 'smoke' : 'graphite'))!
}
export function applyAppearance(preset: Appearance) {
  document.documentElement.dataset.theme = preset.theme
  document.documentElement.dataset.material = preset.material
  document.documentElement.dataset.appearance = preset.key
}
