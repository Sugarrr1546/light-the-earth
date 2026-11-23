/** Provided by the desktop app, where the atlas lives in a folder on this computer and there is no account. */
export interface DesktopBridge {
  platform: string;
  dataDirectory: string;
  revealData(): Promise<void>;
}

export function desktopBridge(): DesktopBridge | undefined {
  return typeof window === 'undefined' ? undefined : (window as Window & { atlasDesktop?: DesktopBridge }).atlasDesktop;
}
