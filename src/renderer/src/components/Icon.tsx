import React from 'react'

const PATHS: Record<string, string> = {
  globe:
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c1.6 0 3.2 2.6 3.8 6H8.2C8.8 6.6 10.4 4 12 4zM4.3 14A8 8 0 0 1 4 12a8 8 0 0 1 .3-2h3.8a20 20 0 0 0 0 4H4.3zm.8 2h3.3c.3 1.6.8 3 1.4 4A8 8 0 0 1 5.1 16zm3.3-8H5.1a8 8 0 0 1 4.7-4c-.6 1-1.1 2.4-1.4 4zM12 20c-1.6 0-3.2-2.6-3.8-6h7.6c-.6 3.4-2.2 6-3.8 6zm4-6a20 20 0 0 0 0-4h3.7a8 8 0 0 1 0 4H16zm-1.8 6c.6-1 1.1-2.4 1.4-4h3.3a8 8 0 0 1-4.7 4zm1.4-12c-.3-1.6-.8-3-1.4-4a8 8 0 0 1 4.7 4h-3.3z',
  download: 'M12 3v11.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4 3.6 3.6V3h2zM4 19h16v2H4v-2z',
  folder: 'M3 5h6l2 2h10v12H3V5zm2 2v10h14V9h-8.8l-2-2H5z',
  play: 'M8 5v14l11-7L8 5z',
  pause: 'M6 5h4v14H6V5zm8 0h4v14h-4V5z',
  lock: 'M17 9V7a5 5 0 0 0-10 0v2H5v12h14V9h-2zm-8-2a3 3 0 0 1 6 0v2H9V7zm8 12H7v-8h10v8z',
  unlock: 'M17 9h-8V7a3 3 0 0 1 5.8-1h2.1A5 5 0 0 0 7 7v2H5v12h14V9h-2zm0 10H7v-8h10v8z',
  settings:
    'M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.7 7.7 0 0 0-1.7-1L15 3H9l-.4 2.7a7.7 7.7 0 0 0-1.7 1l-2.5-1-2 3.5L4.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L9 21h6l.4-2.7c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5L19.4 13zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
  back: 'M15.4 6.4 14 5l-7 7 7 7 1.4-1.4L9.8 12l5.6-5.6z',
  forward: 'M8.6 6.4 10 5l7 7-7 7-1.4-1.4 5.6-5.6-5.6-5.6z',
  reload: 'M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
  close: 'M18.3 5.7 12 12l6.3 6.3-1.4 1.4L12 13.4l-6.3 6.3-1.4-1.4L10.6 12 4.3 5.7l1.4-1.4L12 10.6l6.3-6.3 1.4 1.4z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z',
  star: 'm12 17.3 6.2 3.7-1.6-7 5.4-4.7-7.2-.6L12 2 9.2 8.7 2 9.3l5.4 4.7-1.6 7 6.2-3.7z',
  starOutline:
    'm12 15 4.3 2.6-1.1-4.9 3.8-3.3-5-.4L12 4.4 10 9 5 9.4l3.8 3.3-1.1 4.9L12 15zm0 2.3-6.2 3.7 1.6-7L2 9.3l7.2-.6L12 2l2.8 6.7 7.2.6-5.4 4.7 1.6 7L12 17.3z',
  search: 'M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z',
  trash: 'M6 7h12l-1 14H7L6 7zm3-4h6l1 2h4v2H4V5h4l1-2z',
  open: 'M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14V3zM5 5h6v2H7v10h10v-4h2v6H5V5z',
  history: 'M13 3a9 9 0 0 0-9 9H1l3.9 3.9L9 12H6a7 7 0 1 1 2 4.9l-1.4 1.4A9 9 0 1 0 13 3zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8H12z',
  list: 'M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z',
  eye: 'M12 5C7 5 2.7 8.1 1 12.5 2.7 16.9 7 20 12 20s9.3-3.1 11-7.5C21.3 8.1 17 5 12 5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  copy: 'M16 1H4v14h2V3h10V1zm3 4H8v18h11V5zm-2 16h-7V7h7v14z',
  stop: 'M6 6h12v12H6V6z',
  rotate: 'M12 5V2L8 6l4 4V7a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7zm-5 7H5a7 7 0 0 0 7 7v3l4-4-4-4v3a5 5 0 0 1-5-5z',
  fullscreen: 'M5 5h5v2H7v3H5V5zm9 0h5v5h-2V7h-3V5zM5 14h2v3h3v2H5v-5zm12 0h2v5h-5v-2h3v-3z',
  shield: 'M12 2 4 5v6c0 5.5 3.4 10.6 8 12 4.6-1.4 8-6.5 8-12V5l-8-3zm0 2.2 6 2.2V11c0 4.4-2.6 8.5-6 9.8-3.4-1.3-6-5.4-6-9.8V6.4l6-2.2z',
  film: 'M4 4h16v16H4V4zm2 2v2h2V6H6zm10 0v2h2V6h-2zM6 10v2h2v-2H6zm10 0v2h2v-2h-2zM6 14v2h2v-2H6zm10 0v2h2v-2h-2zm-6-8v12h4V6h-4z',
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
  warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  export: 'M12 16 7 11l1.4-1.4 2.6 2.6V3h2v9.2l2.6-2.6L17 11l-5 5zM4 19h16v2H4v-2z',
  more: 'M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'
}

export function Icon({ name, size = 18, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }): React.JSX.Element {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  )
}
