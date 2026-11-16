// Renders resources/icons/icon.svg to resources/build/icon.png (1024 px) with Electron's
// own Chromium, so no image tooling is needed. electron-builder derives the Windows .ico,
// macOS .icns and Linux icon set from that PNG.
//
//   npx electron scripts/render-icon.cjs
//
// Development tool only; it is not part of the application.
const { app, BrowserWindow } = require('electron')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

// Keep Electron's profile for this tool out of the user's application data.
app.setPath('userData', join(tmpdir(), 'ytdlpp-render-icon'))
app.disableHardwareAcceleration()

const root = join(__dirname, '..')
const svg = readFileSync(join(root, 'resources', 'icons', 'icon.svg'), 'utf8')
const SIZE = 1024

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, javascript: false }
  })
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
  const png = image.resize({ width: SIZE, height: SIZE, quality: 'best' }).toPNG()
  mkdirSync(join(root, 'resources', 'build'), { recursive: true })
  writeFileSync(join(root, 'resources', 'build', 'icon.png'), png)
  console.log(`resources/build/icon.png: ${image.getSize().width}x${image.getSize().height}, ${png.length} bytes`)

  // Windows icon: an .ico holding PNG images at the sizes Explorer and the taskbar use
  // (PNG-compressed entries are valid since Windows Vista). electron-builder uses it as is.
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const entries = sizes.map((size) => image.resize({ width: size, height: size, quality: 'best' }).toPNG())
  const header = Buffer.alloc(6 + 16 * sizes.length)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  sizes.forEach((size, i) => {
    const at = 6 + 16 * i
    header.writeUInt8(size === 256 ? 0 : size, at) // 0 means 256
    header.writeUInt8(size === 256 ? 0 : size, at + 1)
    header.writeUInt8(0, at + 2) // palette colours
    header.writeUInt8(0, at + 3) // reserved
    header.writeUInt16LE(1, at + 4) // colour planes
    header.writeUInt16LE(32, at + 6) // bits per pixel
    header.writeUInt32LE(entries[i].length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += entries[i].length
  })
  const ico = Buffer.concat([header, ...entries])
  writeFileSync(join(root, 'resources', 'build', 'icon.ico'), ico)
  console.log(`resources/build/icon.ico: ${sizes.join(', ')} px, ${ico.length} bytes`)
  app.quit()
})
