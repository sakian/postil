import { Children, isValidElement, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlight, renderTokens, type Token } from '../highlight/index.tsx';

/** A fenced code block, coloured once its tokens arrive from the worker. */
function Code({ source, lang }: { source: string; lang: string | undefined }) {
  const [tokens, setTokens] = useState<Token[][] | null>(null);
  useEffect(() => {
    let live = true;
    if (lang) void highlight(source, lang).then((t) => live && setTokens(t));
    return () => { live = false; };
  }, [source, lang]);
  const lines = source.split('\n');
  return (
    <pre className="md-pre" data-lang={lang}>
      <code>{lines.map((l, i) => <span key={i}>{renderTokens(l, tokens?.[i])}{i < lines.length - 1 ? '\n' : ''}</span>)}</code>
    </pre>
  );
}

/** How a suggestion can be applied: ready, already done, or blocked with a reason. */
export interface ApplyState {
  state: 'ready' | 'applied' | 'blocked';
  reason?: string;
  run(): Promise<void>;
}

function Suggestion({ before, after, apply }: { before: string | null; after: string; apply: ApplyState | undefined }) {
  const lines = (s: string) => (s === '' ? [] : s.split('\n'));
  const [busy, setBusy] = useState(false);
  return (
    <div className="suggestion">
      <div className="suggestion-title">
        Suggested change
        <span className="spacer" />
        {apply?.state === 'applied' && <span className="chip chip-resolved">Applied</span>}
        {apply && apply.state !== 'applied' && (
          <button className="btn btn-small" disabled={apply.state === 'blocked' || busy} title={apply.reason ?? 'Write this change into the working tree'}
            onClick={async () => { setBusy(true); try { await apply.run(); } finally { setBusy(false); } }}>
            {busy ? 'Applying…' : 'Apply suggestion'}
          </button>
        )}
      </div>
      <table className="diff diff-unified suggestion-diff">
        <tbody>
          {before !== null && lines(before).map((l, i) => (
            <tr key={`b${i}`} className="line del"><td className="marker">-</td><td className="code"><span className="code-text">{l}</span></td></tr>
          ))}
          {lines(after).map((l, i) => (
            <tr key={`a${i}`} className="line add"><td className="marker">+</td><td className="code"><span className="code-text">{l}</span></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Comment text. Raw HTML in the source is shown as text, never rendered, and the page's
 * content security policy blocks remote images, so nothing in a comment can reach the network.
 */
export function Markdown({ text, suggestionBase, apply }: { text: string; suggestionBase: string | null; apply?: ApplyState }) {
  const components: Components = {
    pre({ children }) {
      const child = Children.toArray(children)[0] as ReactNode;
      if (isValidElement(child)) {
        const props = (child as ReactElement<{ className?: string; children?: ReactNode }>).props;
        const lang = /language-([\w-]+)/.exec(props.className ?? '')?.[1];
        const source = String(props.children ?? '').replace(/\n$/, '');
        if (lang === 'suggestion') return <Suggestion before={suggestionBase} after={source} apply={apply} />;
        return <Code source={source} lang={lang} />;
      }
      return <pre className="md-pre">{children}</pre>;
    },
    a({ href, children }) {
      return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
    },
  };
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  );
}
