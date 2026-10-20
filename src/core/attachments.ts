/**
 * Files attached to comments. A comment refers to one as `attachment:<blob>` in a Markdown image or
 * link, so the text alone says what it shows, and the UI and Claude both resolve it. Pure, so the
 * browser bundle can use it too.
 */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** `attachment:<blob>` wherever it appears in Markdown. */
const REFERENCE = /attachment:([0-9a-f]{40}|[0-9a-f]{64})\b/g;

/** Image types the UI shows inline. Anything else is offered as a download. */
export const IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml',
]);

/** Blob ids a body refers to, in order of first mention. */
export function attachmentRefs(body: string): string[] {
  return [...new Set([...body.matchAll(REFERENCE)].map((m) => m[1]!))];
}

/** The blob an `attachment:` URL names, or null for any other URL. */
export function attachmentBlob(url: string): string | null {
  const m = /^attachment:([0-9a-f]{40}|[0-9a-f]{64})$/.exec(url);
  return m?.[1] ?? null;
}

/**
 * A file name safe to show, to offer as a download name, and to write into a directory: no
 * directories, no characters Windows refuses, nothing that names the directory itself.
 */
export function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '').trim().slice(0, 200);
  return /^\.*$/.test(base) ? 'attachment' : base;
}

/** A media type as sent by a browser, reduced to `type/subtype`; unknown or malformed is octet-stream. */
export function cleanType(type: string | undefined): string {
  const t = (type ?? '').split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/.test(t) ? t : 'application/octet-stream';
}

/** The Markdown that embeds an attachment: an image for images, a link for anything else. */
export function attachmentMarkdown(a: { blob: string; name: string; type: string }): string {
  const label = a.name.replace(/[[\]\\]/g, '\\$&');
  return `${IMAGE_TYPES.has(a.type) ? '!' : ''}[${label}](attachment:${a.blob})`;
}
