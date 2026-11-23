import type { Metadata } from "next";
import "./globals.css";
import "maplibre-gl/dist/maplibre-gl.css";

export const metadata: Metadata = {
  title: "点亮地球 · 一颗属于你的旅行地球",
  description: "用点亮收藏足迹，用照片保存回忆。你的私人旅行地图。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{__html:`(()=>{let p='system';try{const v=localStorage.getItem('atlas-appearance');if(v==='light'||v==='dark')p=v;}catch{}const t=p==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):p;document.documentElement.dataset.theme=t;document.documentElement.dataset.appearance=p;document.documentElement.style.colorScheme=t;})();`}}/></head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
