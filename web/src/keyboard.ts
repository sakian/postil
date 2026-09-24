import { useStore } from './store.ts';

export const KEYMAP: Array<[string, string]> = [
  ['j / k', 'Next / previous file'],
  ['n / p', 'Next / previous conversation'],
  ['d', 'Mark the section at the top of the screen done, or not done'],
  ['v', 'Toggle "Viewed" on the current file'],
  ['f', 'Fold or unfold the current file'],
  ['e / E', 'Expand / collapse all context in the current file'],
  ['s', 'Switch between unified and split view'],
  ['c', 'Open conversations'],
  ['r', 'Finish your review'],
  ['?', 'Show this help'],
  ['Esc', 'Close a panel or cancel a comment'],
];

function main(): HTMLElement | null {
  return document.querySelector('main.main');
}

/** Top edge of the reading area, below the sticky file header. */
function readingTop(): number {
  return (main()?.getBoundingClientRect().top ?? 0) + 40;
}

function files(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('section.file')];
}

/** The file whose content is at the top of the reading area. */
export function currentFile(): HTMLElement | null {
  const top = readingTop();
  return files().find((f) => f.getBoundingClientRect().bottom > top) ?? null;
}

function scrollTo(el: Element): void {
  el.scrollIntoView({ block: 'start' });
}

/** Move to the file after (or before) the one being read. */
function stepFile(dir: 1 | -1): void {
  const all = files();
  const current = currentFile();
  const index = current ? all.indexOf(current) : -1;
  const target = all[Math.min(all.length - 1, Math.max(0, index + dir))];
  if (target && target !== current) scrollTo(target);
}

function stepThread(dir: 1 | -1): void {
  const threads = [...document.querySelectorAll<HTMLElement>('main.main .thread[id^="thread-"]')];
  const mid = window.innerHeight / 2;
  const target =
    dir === 1
      ? threads.find((t) => t.getBoundingClientRect().top > mid + 4)
      : [...threads].reverse().find((t) => t.getBoundingClientRect().top < mid - 4);
  const id = Number(target?.id.replace('thread-', ''));
  if (Number.isFinite(id) && id > 0) useStore.getState().focus(id);
}

function clickIn(file: HTMLElement | null, selector: string): void {
  file?.querySelector<HTMLElement>(selector)?.click();
}

/** The first section toggle on screen: the section the reader is looking at. */
function toggleTopSection(): void {
  const top = readingTop();
  const toggles = [...document.querySelectorAll<HTMLElement>('main.main .done-toggle')];
  const target = toggles.find((t) => t.getBoundingClientRect().top >= top - 8 && t.getBoundingClientRect().top < window.innerHeight);
  target?.click();
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** Handle a key press; returns true when it was a postil shortcut. */
export function handleKey(e: KeyboardEvent, showHelp: (show: boolean) => void): boolean {
  if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return false;
  const s = useStore.getState();
  switch (e.key) {
    case 's':
    case 'S':
      s.setView(s.view === 'split' ? 'unified' : 'split');
      return true;
    case 'j':
      stepFile(1);
      return true;
    case 'k':
      stepFile(-1);
      return true;
    case 'n':
      stepThread(1);
      return true;
    case 'p':
      stepThread(-1);
      return true;
    case 'd':
      toggleTopSection();
      return true;
    case 'v':
      clickIn(currentFile(), '[data-action="viewed"]');
      return true;
    case 'f':
      clickIn(currentFile(), '[data-action="fold"]');
      return true;
    case 'e':
      clickIn(currentFile(), '[data-action="expand-all"]');
      return true;
    case 'E':
      clickIn(currentFile(), '[data-action="collapse-all"]');
      return true;
    case 'c':
      s.setPanel(s.panel === 'threads' ? null : 'threads');
      return true;
    case 'r':
      s.setPanel(s.panel === 'review' ? null : 'review');
      return true;
    case '?':
      showHelp(true);
      return true;
    case 'Escape':
      showHelp(false);
      if (s.composer) s.openComposer(null);
      else if (s.panel) s.setPanel(null);
      else s.select(null);
      return true;
    default:
      return false;
  }
}
