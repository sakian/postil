import type { ReactElement } from 'react';

const paths: Record<string, string> = {
  chevronDown: 'M4 6l4 4 4-4',
  chevronRight: 'M6 4l4 4-4 4',
  expandUp: 'M8 3v10M4 7l4-4 4 4',
  expandDown: 'M8 13V3M4 9l4 4 4-4',
  expandBoth: 'M8 2v12M5 5l3-3 3 3M5 11l3 3 3-3',
  collapse: 'M5 3l3 3 3-3M5 13l3-3 3 3',
  plus: 'M8 3v10M3 8h10',
  comment: 'M3 3h10v7H7l-3 3v-3H3z',
  check: 'M3 8.5l3 3 7-7',
  file: 'M4 2h5l3 3v9H4zM9 2v3h3',
  folder: 'M2 4h4l1.5 1.5H14V13H2z',
  close: 'M4 4l8 8M12 4l-8 8',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5',
  unfold: 'M8 2v4M5 4l3 2 3-2M8 14v-4M5 12l3-2 3 2M2 8h12',
  fold: 'M8 2v4M5 3l3 3 3-3M8 14v-4M5 13l3-3 3 3M2 8h12',
};

export function Icon({ name, size = 16, title }: { name: keyof typeof paths; size?: number; title?: string }): ReactElement {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={paths[name]} />
    </svg>
  );
}
