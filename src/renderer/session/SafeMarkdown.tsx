import { Fragment, memo, useMemo } from 'react';
import { inlineParts, markdownBlocks } from './markdown-model.js';
import type { MarkdownBlock } from './markdown-model.js';

/** 只渲染安全节点；HTML 保留为文本，链接和附件均不自动访问。 */
export const SafeMarkdown = memo(function SafeMarkdown({ text }: { readonly text: string }) {
  const blocks = useMemo(() => markdownBlocks(text), [text]);
  return <div className="safe-markdown"><Markup blocks={blocks} /></div>;
});
function Inline({ text }: { readonly text: string }) {
  return <>{inlineParts(text).map((part, index) => part.kind === 'strong' ? <strong key={index}>{part.text}</strong>
    : part.kind === 'em' ? <em key={index}>{part.text}</em> : part.kind === 'code' ? <code className="inline-code" key={index}>{part.text}</code>
      : part.kind === 'strike' ? <del key={index}>{part.text}</del>
        : part.kind === 'attachment' ? <span className="attachment-placeholder" key={index}>{part.text}</span>
          : part.kind === 'link' ? <span className="markdown-link-text" key={index} title="原生面板保留链接文本，不自动访问；可在原网页打开。">{part.text}</span>
            : <Fragment key={index}>{part.text}</Fragment>)}</>;
}
function Markup({ blocks }: { readonly blocks: readonly MarkdownBlock[] }) {
  return <>{blocks.map((block, index) => {
    if (block.kind === 'code') return <div className="code-block" key={index}>{block.language !== '' && <div className="code-language">{block.language}</div>}<pre><code>{block.text}</code></pre></div>;
    if (block.kind === 'heading') return <div className={`markdown-heading heading-${block.level}`} role="heading" aria-level={block.level} key={index}><Inline text={block.text} /></div>;
    if (block.kind === 'quote') return <blockquote key={index}><Markup blocks={block.blocks} /></blockquote>;
    if (block.kind === 'rule') return <hr key={index} />;
    if (block.kind === 'list') {
      const items = block.items.map((item, itemIndex) => <li key={itemIndex} className={item.checked === undefined ? undefined : 'markdown-task-item'}>
        {item.checked !== undefined && <input type="checkbox" checked={item.checked} disabled readOnly aria-label={item.checked ? '已完成任务项' : '未完成任务项'} />}<Inline text={item.text} />
      </li>);
      return block.ordered ? <ol start={block.start} key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
    }
    if (block.kind === 'table') return <div className="markdown-table" key={index}><table><thead><tr>{block.head.map((cell, column) => <th key={column} style={{ textAlign: block.align[column] ?? 'left' }}><Inline text={cell} /></th>)}</tr></thead>
      <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column} style={{ textAlign: block.align[column] ?? 'left' }}><Inline text={cell} /></td>)}</tr>)}</tbody></table></div>;
    return <p className={block.kind === 'notice' ? 'muted markdown-notice' : undefined} key={index}><Inline text={block.text} /></p>;
  })}</>;
}
