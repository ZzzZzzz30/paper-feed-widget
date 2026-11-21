import { app } from 'electron'
import fs from 'fs'
import path from 'path'

export function configureDataDirectory(): void {
  const appData = app.getPath('appData')
  const previous = app.getPath('userData')
  const directory = path.join(appData, app.isPackaged ? 'PaperFeed' : 'paper-feed-widget')
  fs.mkdirSync(directory, { recursive: true })

  const database = path.join(directory, 'paperfeed.db')
  if (app.isPackaged && !fs.existsSync(database)) {
    const legacyPaths = [previous, path.join(appData, 'paper-feed-widget')]
    for (const legacyPath of legacyPaths) {
      if (path.resolve(legacyPath).toLowerCase() === path.resolve(directory).toLowerCase()) continue
      const legacyDatabase = path.join(legacyPath, 'paperfeed.db')
      if (!fs.existsSync(legacyDatabase)) continue
      try {
        fs.copyFileSync(legacyDatabase, database, fs.constants.COPYFILE_EXCL)
        console.log('[Data] Copied existing user database to the stable product directory')
        break
      } catch (error) {
        console.error('[Data] Could not migrate existing user database', error)
        break
      }
    }
  }

  app.setPath('userData', directory)
}
