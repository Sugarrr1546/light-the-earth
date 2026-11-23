// Applies the saved appearance before first paint, as app/layout.tsx does for the hosted site.
(()=>{let p='system';try{const v=localStorage.getItem('atlas-appearance');if(v==='light'||v==='dark')p=v;}catch{}const t=p==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):p;document.documentElement.dataset.theme=t;document.documentElement.dataset.appearance=p;document.documentElement.style.colorScheme=t;})();
// Lets app/globals.css make room for the window buttons that overlay the header on macOS.
if(window.atlasDesktop)document.documentElement.dataset.desktop=window.atlasDesktop.platform;
