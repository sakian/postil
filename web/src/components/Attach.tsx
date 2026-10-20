import { useRef, useState, type ClipboardEvent, type DragEvent, type ReactElement, type RefObject } from 'react';
import { api } from '../api.ts';
import { insertBlock } from '../lib/text.ts';
import { useStore } from '../store.ts';

/**
 * Attaching files to a comment by pasting, dropping or picking them. Each is uploaded and its
 * Markdown inserted where the cursor was when the upload began.
 */
export function useAttach(ref: RefObject<HTMLTextAreaElement | null>, update: (fn: (prev: string) => string) => void): {
  uploading: number;
  textareaProps: { onPaste(e: ClipboardEvent): void; onDragOver(e: DragEvent): void; onDrop(e: DragEvent): void };
  button: ReactElement;
} {
  const [uploading, setUploading] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const attach = async (files: File[]) => {
    if (files.length === 0) return;
    const el = ref.current;
    const at = el ? ([el.selectionStart, el.selectionEnd] as const) : null;
    setUploading((n) => n + files.length);
    const links: string[] = [];
    for (const file of files) {
      try {
        links.push((await api.uploadAttachment(file, file.name)).markdown);
      } catch (e) {
        useStore.getState().toast(`Could not attach ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (links.length) update((prev) => insertBlock(prev, at, links.join('\n')));
  };

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  return {
    uploading,
    textareaProps: {
      // A screenshot pastes as a file alone. Text copied with a picture of itself (a spreadsheet) stays text.
      onPaste(e) {
        const files = Array.from(e.clipboardData.files);
        if (files.length === 0 || e.clipboardData.types.includes('text/plain')) return;
        e.preventDefault();
        void attach(files);
      },
      onDragOver(e) {
        if (hasFiles(e)) e.preventDefault();
      },
      onDrop(e) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        void attach(Array.from(e.dataTransfer.files));
      },
    },
    button: (
      <>
        <button className="link-btn" onClick={() => input.current?.click()} title="Attach images or other files. You can also paste or drop them.">
          {uploading ? 'Uploading…' : 'Attach files'}
        </button>
        <input ref={input} type="file" multiple hidden onChange={(e) => {
          void attach(Array.from(e.target.files ?? []));
          e.target.value = '';
        }} />
      </>
    ),
  };
}
