import { Tray, Menu, BrowserWindow, app, nativeImage } from 'electron'
import path from 'path'

export function createTray(widgetWindow: BrowserWindow | null): Tray {
  const iconPath = path.join(__dirname, '..', '..', 'resources', 'icon.png')
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  const tray = new Tray(icon)
  tray.setToolTip('PaperFeed - 期刊论文推送')

  const contextMenu = Menu.buildFromTemplate([
    { label: '设置', click: () => { widgetWindow?.webContents.send('navigate', 'settings') } },
    { type: 'separator' },
    { label: '退出', click: () => { (app as unknown as Record<string, unknown>).isQuitting = true; app.quit() } },
  ])

  tray.setContextMenu(contextMenu)
  tray.on('click', () => {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      if (!widgetWindow.isVisible()) widgetWindow.show()
      widgetWindow.focus()
    }
  })
  return tray
}
