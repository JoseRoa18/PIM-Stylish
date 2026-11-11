import { Link } from 'react-router-dom';
import { parseMarkdown } from '../lib/markdown';

// The assistant answers in Markdown. This draws the part of it an answer
// uses — paragraphs, headings, lists (nested), tables, code, quotes, bold,
// italics, links — as React elements, never as raw HTML: whatever the text
// holds, it is shown as text. An answer still being written (half a table, an
// open "**") simply shows as it stands.

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\s][^*\n]*?\*)|(\b_[^_\n]+?_\b)/;

function link(label, href, key) {
  const text = inline(label, key);
  // A page of the app opens in place; another site in a new tab; anything
  // else (a script, a file) is only its text.
  if (href.startsWith('/') && !href.startsWith('//')) {
    return <Link key={key} to={href} className="text-primary underline underline-offset-2 hover:opacity-80">{text}</Link>;
  }
  if (/^https?:\/\//i.test(href)) {
    return <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="text-primary underline underline-offset-2 hover:opacity-80">{text}</a>;
  }
  return <span key={key}>{text}</span>;
}

function inline(text, key = 'i') {
  const out = [];
  const re = new RegExp(INLINE.source, 'g');
  let last = 0;
  let n = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const k = `${key}.${n++}`;
    if (m[1]) out.push(<code key={k} className="px-1 py-0.5 rounded bg-surface-container-high font-mono text-[0.9em]">{token.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k} className="font-semibold text-on-surface">{inline(token.slice(2, -2), k)}</strong>);
    else if (m[3]) {
      const parts = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      out.push(link(parts[1], parts[2], k));
    } else out.push(<em key={k}>{inline(token.slice(1, -1), k)}</em>);
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Text with its line breaks kept. */
function lines(text, key) {
  return text.split('\n').flatMap((line, i) => (i ? [<br key={`${key}.br${i}`} />, ...inline(line, `${key}.${i}`)] : inline(line, `${key}.${i}`)));
}

/** A flat run of items, as a list with its deeper items nested under their parent. */
function List({ items, k }) {
  const base = items[0].indent;
  const groups = [];
  for (const item of items) {
    if (item.indent <= base || !groups.length) groups.push({ item, children: [] });
    else groups.at(-1).children.push(item);
  }
  const Tag = items[0].ordered ? 'ol' : 'ul';
  return (
    <Tag start={items[0].ordered && items[0].start !== 1 ? items[0].start : undefined} className={`${items[0].ordered ? 'list-decimal' : 'list-disc'} pl-5 space-y-1 marker:text-on-surface-variant`}>
      {groups.map((g, i) => (
        <li key={`${k}.${i}`}>
          {lines(g.item.text, `${k}.${i}`)}
          {g.children.length > 0 && <div className="mt-1"><List items={g.children} k={`${k}.${i}c`} /></div>}
        </li>
      ))}
    </Tag>
  );
}

export default function Markdown({ text }) {
  const blocks = parseMarkdown(text ?? '');
  // An answer sits under the page's h1 and its question (an h2): its largest
  // heading is an h3, whatever "#" the text used.
  const top = Math.min(6, ...blocks.filter((b) => b.type === 'heading').map((b) => b.level));
  return (
    <div className="space-y-3 text-body-md text-on-surface leading-relaxed [overflow-wrap:anywhere]">
      {blocks.map((b, i) => {
        const k = `b${i}`;
        if (b.type === 'heading') {
          const depth = b.level - top;
          const Tag = `h${Math.min(3 + depth, 6)}`;
          return <Tag key={k} className={`${depth === 0 ? 'text-title-lg' : 'text-title-md'} text-on-surface pt-1`}>{inline(b.text, k)}</Tag>;
        }
        if (b.type === 'code') {
          return <pre key={k} tabIndex={0} className="p-3 rounded-lg bg-surface-container-high overflow-x-auto text-body-sm font-mono [overflow-wrap:normal]"><code>{b.text}</code></pre>;
        }
        if (b.type === 'rule') return <hr key={k} className="border-outline-variant" />;
        if (b.type === 'quote') return <blockquote key={k} className="border-l-2 border-outline-variant pl-3 text-on-surface-variant">{lines(b.text, k)}</blockquote>;
        if (b.type === 'list') return <List key={k} items={b.items} k={k} />;
        if (b.type === 'table') {
          return (
            // relative + tabIndex: a wide table scrolls inside its own box, reachable by keyboard.
            <div key={k} tabIndex={0} className="relative overflow-x-auto rounded-lg border border-outline-variant [overflow-wrap:normal]">
              <table className="w-full text-body-sm border-collapse">
                <thead>
                  <tr className="bg-surface-container-low">
                    {b.head.map((h, c) => <th key={c} scope="col" className="text-left font-semibold px-3 py-2 border-b border-outline-variant whitespace-nowrap">{inline(h, `${k}.h${c}`)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, r) => (
                    <tr key={r} className="border-b border-outline-variant/60 last:border-b-0">
                      {b.head.map((_, c) => <td key={c} className="px-3 py-2 align-top">{inline(row[c] ?? '', `${k}.${r}.${c}`)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return <p key={k}>{lines(b.text, k)}</p>;
      })}
    </div>
  );
}
