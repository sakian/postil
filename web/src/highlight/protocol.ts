/** A highlighted run of text: content, light-theme colour, dark-theme colour. */
export type Token = [content: string, light: string, dark: string];

export interface HighlightRequest {
  id: number;
  text: string;
  /** A file path (the extension picks the language) or a Markdown fence language name. */
  language: string;
}

export interface HighlightResponse {
  id: number;
  /** Tokens per line, or null when the language is unknown or highlighting failed. */
  lines: Token[][] | null;
  error?: string;
}
