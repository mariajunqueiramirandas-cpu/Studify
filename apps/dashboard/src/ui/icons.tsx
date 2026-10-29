// Line icons on a 24px grid, 1.8px strokes. Drawn for the dashboard; decorative unless given a label.
import type { SVGProps } from 'react';

const PATHS = {
  home: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5',
  bell: 'M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15zM10 21h4',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.9-3.3 3.3-5 6.5-5s5.6 1.7 6.5 5M16 4.3a3.5 3.5 0 0 1 0 6.4M18 15.2c1.8.7 3 2.3 3.5 4.8',
  phone: 'M7.5 2.5h9a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V4a1.5 1.5 0 0 1 1.5-1.5zM10.5 18.5h3',
  shield: 'M12 3 4.5 6v5.5c0 4.6 3.1 8.4 7.5 9.5 4.4-1.1 7.5-4.9 7.5-9.5V6zM9 12l2 2 4-4',
  chart: 'M4 20h16M7 16.5V11M12 16.5V6.5M17 16.5v-3.5',
  sparkles: 'M12 3.5l1.6 4.4L18 9.5l-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8zM5.5 15.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z',
  users: 'M3.5 5.5h17M3.5 12h17M3.5 18.5h10',
  school: 'M3 9.5 12 5l9 4.5-9 4.5zM7 11.5v4.5c1.3 1.3 3 2 5 2s3.7-.7 5-2v-4.5M21 9.5V15',
  flag: 'M5.5 21V4M5.5 4.5h11l-2 4 2 4h-11',
  ticket: 'M3.5 7.5a1 1 0 0 1 1-1h15a1 1 0 0 1 1 1v2.8a1.7 1.7 0 0 0 0 3.4v2.8a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-2.8a1.7 1.7 0 0 0 0-3.4zM14.5 6.5v11',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5',
  scroll: 'M7 3.5h10a2 2 0 0 1 2 2V19a1.5 1.5 0 0 1-3 0v-1.5H5V5.5a2 2 0 0 1 2-2zM8.5 8h7M8.5 11.5h7M8.5 15h4',
  logout: 'M14 4.5h4a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4M10 16l-4-4 4-4M6 12h10',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 4 2.8 19.5h18.4zM12 10v4.5M12 17.2v.3',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.8v.2',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2',
  copy: 'M9 9h10.5v11.5H9zM15 9V4.5H4.5V15H9',
  download: 'M12 4v11M7.5 11l4.5 4.5 4.5-4.5M4.5 19.5h15',
  trash: 'M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13.5h9l1-13.5M10 10.5v6M14 10.5v6',
  search: 'M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM15.5 15.5 20 20',
  left: 'M14.5 6 8.5 12l6 6',
  right: 'M9.5 6l6 6-6 6',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
  mail: 'M3.5 6h17v12h-17zM3.5 6.5l8.5 6.5 8.5-6.5',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.8 5.8l12.4 12.4',
  external: 'M14 4.5h5.5V10M19.5 4.5 11 13M17 14v5.5H4.5V7H10',
  book: 'M4 5.5c2.7-1.3 5.3-1.2 8 .5 2.7-1.7 5.3-1.8 8-.5v13c-2.7-1.3-5.3-1.2-8 .5-2.7-1.7-5.3-1.8-8-.5zM12 6v13',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, label, ...rest }: { name: IconName; size?: number; label?: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
