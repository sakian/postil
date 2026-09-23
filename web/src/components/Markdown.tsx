import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

function Suggestion({ before, after }: { before: string | null; after: string }) {
  const lines = (s: string) => (s === '' ? [''] : s.split('\n'));
  return (
    <div className="suggestion">
      <div className="suggestion-title">Suggested change</div>
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
export function Markdown({ text, suggestionBase }: { text: string; suggestionBase: string | null }) {
  const components: Components = {
    pre({ children }) {
      const child = Children.toArray(children)[0] as ReactNode;
      if (isValidElement(child)) {
        const props = (child as ReactElement<{ className?: string; children?: ReactNode }>).props;
        const lang = /language-([\w-]+)/.exec(props.className ?? '')?.[1];
        const source = String(props.children ?? '').replace(/\n$/, '');
        if (lang === 'suggestion') return <Suggestion before={suggestionBase} after={source} />;
        return <pre className="md-pre" data-lang={lang}><code>{source}</code></pre>;
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
