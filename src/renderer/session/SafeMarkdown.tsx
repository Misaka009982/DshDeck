import { Fragment } from 'react';

/** 基础 Markdown 展示不解析 HTML、不访问链接或本地附件，代码按纯文本呈现。 */
export function SafeMarkdown({ text }: { readonly text: string }) {
  const blocks = text.split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/gmu);
  return <div className="safe-markdown">{blocks.map((block, index) => {
    if (block.startsWith('```')) {
      const lines = block.split('\n'); const language = (lines.shift() ?? '').slice(3).trim(); lines.pop();
      return <div className="code-block" key={index}>{language !== '' && <div className="code-language">{language}</div>}<pre><code>{lines.join('\n')}</code></pre></div>;
    }
    return <Fragment key={index}>{block.split(/\n\s*\n/u).filter(part => part !== '').map((part, partIndex) => {
      const heading = /^(#{1,3})\s+(.+)$/u.exec(part);
      if (heading !== null) return <div className={`markdown-heading heading-${heading[1]?.length ?? 1}`} key={partIndex}>{heading[2]}</div>;
      return <p key={partIndex}>{part}</p>;
    })}</Fragment>;
  })}</div>;
}
