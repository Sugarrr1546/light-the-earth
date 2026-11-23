import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session, shell } from 'electron';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createLocalApi } from '../lib/local-api.ts';
import { openFileStore } from './file-store.ts';

const SCHEME = 'atlas';
const ORIGIN = `${SCHEME}://app`;
const UNUSED_PHOTO_AGE = 24 * 60 * 60 * 1000;
const TRAFFIC_LIGHT_X = 20, TRAFFIC_LIGHT_SIZE = 14;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.gz': 'application/gzip', '.txt': 'text/plain; charset=utf-8', '.pbf': 'application/x-protobuf',
};
// Everything the interface needs ships inside the app; nothing is fetched from the network.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "worker-src 'self' blob:", "connect-src 'self' data: blob:", "font-src 'self' data:", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

// Tests and previews point the app at a throwaway profile so they never touch a real atlas.
if (process.env.ATLAS_USER_DATA) app.setPath('userData', process.env.ATLAS_USER_DATA);
// Lets the page hand freed memory back to the system after it releases country geometry (see RELEASE_IDLE_MS in
// components/EarthMap.tsx); V8 otherwise keeps it until the next burst of work, which at an idle globe may never come.
app.commandLine.appendSwitch('js-flags', '--expose-gc');
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }]);

const webRoot = process.env.ATLAS_WEB_ROOT ?? (app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(import.meta.dirname, '..', 'web'));

async function staticFile(pathname: string): Promise<Response> {
  let relative: string;
  try { relative = decodeURIComponent(pathname); } catch { return new Response(null, { status: 400 }); }
  if (relative.endsWith('/')) relative += 'index.html';
  const file = path.join(webRoot, relative);
  if (!file.startsWith(webRoot + path.sep) || relative.split('/').some((part) => part.startsWith('.'))) return new Response(null, { status: 403 });
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return new Response(null, { status: 404 });
  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: {
    'Content-Type': type, 'Content-Length': String(info.size), 'X-Content-Type-Options': 'nosniff',
    ...(type.startsWith('text/html') ? { 'Content-Security-Policy': CONTENT_SECURITY_POLICY, 'Cache-Control': 'no-cache' } : {}),
  } });
}

function createMenu(dataDirectory: string): Menu {
  const mac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(mac ? [{ label: app.name, submenu: [
      { role: 'about' as const, label: `关于${app.name}` }, { type: 'separator' as const },
      { role: 'hide' as const, label: `隐藏${app.name}` }, { role: 'hideOthers' as const, label: '隐藏其他' }, { role: 'unhide' as const, label: '全部显示' },
      { type: 'separator' as const }, { role: 'quit' as const, label: `退出${app.name}` },
    ] }] : []),
    { label: '文件', submenu: [
      { label: mac ? '在访达中显示数据文件夹' : '打开数据文件夹', click: () => void shell.openPath(dataDirectory) },
      ...(mac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const, label: '退出' }]),
    ] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
      { role: 'cut', label: '剪切' }, { role: 'copy', label: '拷贝' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
    ] },
    { label: '显示', submenu: [
      { role: 'reload', label: '重新载入' }, { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大界面' }, { role: 'zoomOut', label: '缩小界面' },
      { type: 'separator' }, { role: 'togglefullscreen', label: '进入或退出全屏' },
      ...(app.isPackaged ? [] : [{ type: 'separator' as const }, { role: 'toggleDevTools' as const, label: '开发者工具' }]),
    ] },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, ...(mac ? [{ role: 'front' as const, label: '前置全部窗口' }] : [{ role: 'close' as const, label: '关闭' }])] },
  ]);
}

async function start(): Promise<void> {
  const dataDirectory = process.env.ATLAS_DATA_DIR ?? path.join(app.getPath('userData'), 'atlas');
  const store = await openFileStore(dataDirectory);
  const api = createLocalApi(store);
  await api.pruneUnusedPhotos(UNUSED_PHOTO_AGE).catch((error) => console.error('Could not clear unused photos', error));

  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response(null, { status: 404 });
    return await api.handle(request) ?? staticFile(url.pathname);
  });
  // The app never needs camera, location or notifications.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  // Automated checks save exported backups without the system dialog.
  if (process.env.ATLAS_DOWNLOAD_DIR) session.defaultSession.on('will-download', (_event, item) => item.setSavePath(path.join(process.env.ATLAS_DOWNLOAD_DIR!, item.getFilename())));
  ipcMain.handle('atlas:reveal-data', () => shell.openPath(dataDirectory));
  Menu.setApplicationMenu(createMenu(dataDirectory));

  const mac = process.platform === 'darwin';
  const window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 520, minHeight: 600, show: false, title: app.name,
    // On macOS the page header doubles as the title bar; see the data-desktop rules in app/globals.css.
    ...(mac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: TRAFFIC_LIGHT_X, y: 33 } } : {}),
    // The map opens on the globe in space in both appearances.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#030711' : '#071321',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
      spellcheck: false, additionalArguments: [`--atlas-data-directory=${dataDirectory}`],
    },
  });
  const external = (url: string) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); };
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(ORIGIN + '/')) { event.preventDefault(); external(url); } });
  window.once('ready-to-show', () => {
    // Automated checks keep the window from taking focus away from whatever is in front.
    if (process.env.ATLAS_SHOW_INACTIVE) window.showInactive(); else window.show();
    if (store.recovered) void dialog.showMessageBox(window, {
      type: 'warning', message: store.recovered === 'backup' ? '已从上一份完好的记录恢复' : '记录文件无法读取',
      detail: (store.recovered === 'backup'
        ? '保存旅行记录的文件已损坏，本次改用上一次保存前的副本，最近一次改动可能缺失。'
        : '保存旅行记录的文件和它的副本都无法读取，本次从空白地图开始。照片文件没有改动。')
        + `\n\n无法读取的原文件已保留在：\n${dataDirectory}`,
    });
  });
  await window.loadURL(ORIGIN + '/');
  if (mac) {
    // Keep the window buttons centred in the page header, whose height changes with the window width,
    // and let the header reclaim their space in full screen.
    const syncChrome = async () => {
      if (window.isDestroyed()) return;
      const fullScreen = window.isFullScreen();
      const height = await window.webContents.executeJavaScript(
        `(()=>{document.documentElement.toggleAttribute('data-fullscreen',${fullScreen});return document.querySelector('.app-header')?.getBoundingClientRect().height??0})()`,
      ).catch(() => 0) as number;
      if (height > 0 && !fullScreen && !window.isDestroyed()) window.setWindowButtonPosition({ x: TRAFFIC_LIGHT_X, y: Math.round((height - TRAFFIC_LIGHT_SIZE) / 2) });
    };
    let pending: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => { clearTimeout(pending); pending = setTimeout(() => void syncChrome(), 80); };
    window.on('resize', schedule); window.on('enter-full-screen', schedule); window.on('leave-full-screen', schedule);
    window.webContents.on('did-finish-load', schedule);
    await syncChrome();
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  // A second copy writing the same atlas file could overwrite newer records, so reuse the open window.
  app.on('second-instance', () => { const [window] = BrowserWindow.getAllWindows(); if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox('点亮地球无法启动', `读取本机旅行记录时出错：\n${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
  });
}
