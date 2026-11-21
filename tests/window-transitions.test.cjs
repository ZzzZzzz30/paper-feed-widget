const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function harness() {
  let cursor = { x: 600, y: 10 }
  const workArea = { x: 0, y: 0, width: 1600, height: 1000 }
  const screen = { getDisplayMatching: () => ({ workArea }), getDisplayNearestPoint: () => ({ workArea }),
    getCursorScreenPoint: () => cursor }
  const exports = {}
  const filename = path.join(__dirname, '../electron/window.ts')
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { exports, require: name => name === 'electron' ? { screen } : require(name),
    process: { platform: 'win32' }, setTimeout: () => ({}), clearTimeout() {}, setInterval: () => ({}), clearInterval() {} })
  const win = {
    bounds: { x: 500, y: 120, width: 440, height: 640 }, min: [1, 1], max: [2000, 2000], onTop: false,
    events: [], shape: [], getBounds() { return { ...this.bounds } }, getContentBounds() { return this.getBounds() },
    setMinimumSize(w, h) { this.min = [w, h] }, setMaximumSize(w, h) { this.max = [w, h] },
    setBounds(b) { this.bounds = { ...b, width: Math.max(this.min[0], Math.min(this.max[0], b.width)),
      height: Math.max(this.min[1], Math.min(this.max[1], b.height)) } },
    setPosition(x, y) { this.bounds.x = x; this.bounds.y = y }, setShape(r) { this.shape = r },
    setMovable() {}, setAlwaysOnTop(v) { this.onTop = v }, isAlwaysOnTop() { return this.onTop },
    isDestroyed: () => false, once() {}, removeListener() {},
  }
  win.webContents = { send: (name, value) => win.events.push({ name, value }) }
  const visible = () => { const r = win.shape[0]; return { ...r, x: r.x + win.bounds.x, y: r.y + win.bounds.y } }
  const transition = (compact, preview = false) => {
    const planned = exports.setWidgetCompact(win, compact, 'prepare', preview)
    const origin = { x: win.bounds.x, y: win.bounds.y }
    const settled = exports.setWidgetCompact(win, compact, 'finish', preview)
    assert.deepEqual({ x: win.bounds.x, y: win.bounds.y }, origin, 'finishing must not move the native bitmap origin')
    assert.deepEqual(settled.to, planned.to, 'last animated frame must equal settled layout')
    assert.deepEqual(win.shape[0], settled.to, 'transparent padding must not capture mouse input')
    return settled.to
  }
  return { api: exports, win, transition, visible, cursor: p => { cursor = p } }
}

test('hover and reader transitions keep final coordinates, hit bounds and window priority', () => {
  const h = harness(), original = { ...h.win.bounds }
  assert.equal(h.transition(true).width, 220)
  assert.equal(h.win.onTop, true)
  h.cursor({ x: h.win.bounds.x + 1, y: 1 })
  assert.equal(h.api.isIslandHovered(h.win), false)
  for (let i = 0; i < 3; i++) {
    assert.equal(h.transition(false, true).width, 360)
    assert.equal(h.transition(true).height, 30)
  }
  h.transition(false)
  assert.equal(h.win.onTop, false)
  assert.deepEqual(h.visible(), original)
  h.api.setWorkspaceExpanded(h.win, true)
  assert.equal(h.visible().width, 880)
  h.transition(true); h.transition(false)
  assert.equal(h.visible().width, 880)
  h.api.setWorkspaceExpanded(h.win, false)
  assert.equal(h.visible().width, 440)
})

test('side docking uses visible bounds despite retained canvas padding', () => {
  const h = harness()
  h.transition(true)
  const island = h.visible()
  h.cursor({ x: island.x + 10, y: island.y + 10 })
  h.api.dragIsland(h.win, 'start')
  h.cursor({ x: 0, y: 400 })
  assert.equal(h.api.dragIsland(h.win, 'end'), true)
  assert.equal(h.visible().x, 0)
  assert.equal(h.visible().width, 38)
  assert.equal(h.visible().height, 220)
  h.transition(false, true)
  h.transition(true)
  assert.equal(h.visible().width, 38)
  h.transition(false)
  assert.equal(h.visible().width, 440)
})

test('top-left resizing after a morph keeps the opposite corner fixed and clamps size', () => {
  const h = harness()
  h.transition(true); h.transition(false)
  h.cursor({ x: 500, y: 120 })
  h.api.resizeSurface(h.win, 'start', 'nw')
  h.cursor({ x: 460, y: 90 })
  h.api.resizeSurface(h.win, 'end')
  assert.deepEqual(h.visible(), { x: 460, y: 90, width: 480, height: 670 })
  h.cursor({ x: 460, y: 90 })
  h.api.resizeSurface(h.win, 'start', 'nw')
  h.cursor({ x: 1000, y: 900 })
  h.api.resizeSurface(h.win, 'end')
  assert.deepEqual(h.visible(), { x: 620, y: 280, width: 320, height: 480 })
  h.transition(true); h.transition(false)
  assert.deepEqual(h.visible(), { x: 620, y: 280, width: 320, height: 480 })
})
