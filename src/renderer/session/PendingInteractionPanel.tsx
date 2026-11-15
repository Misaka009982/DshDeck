import { useState } from 'react';
import type { PendingInteraction, SessionContext } from '../../shared/domain.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';

export function PendingInteractionPanel({ pending, context, store }: { readonly pending: readonly PendingInteraction[]; readonly context: SessionContext; readonly store: WorkbenchClientStore }) {
  return <div className="pending-stack">{pending.map(item => <Interaction key={`${item.generation}:${item.id}`} item={item} context={context} store={store} />)}</div>;
}
function Interaction({ item, context, store }: { item: PendingInteraction; context: SessionContext; store: WorkbenchClientStore }) {
  const [answers, setAnswers] = useState<Record<string, { selected: string[]; custom: string }>>({});
  const [sending, setSending] = useState(false);
  const answer = (value: string): void => {
    if (sending) return; setSending(true);
    void store.action(store.api.answer({ context, interactionId: item.id, value })).finally(() => setSending(false));
  };
  return <section className="pending-card" role="region" aria-label="等待用户交互">
    <header><span className="task-light light-yellow" />{item.kind === 'approval' ? '需要权限决定' : item.kind === 'question' ? 'dsh 正在等待回答' : '交互需要兼容页面'}</header>
    <p className="pending-prompt">{item.prompt}</p>
    {item.kind === 'question' && item.questions.map(question => {
      const value = answers[question.id] ?? { selected: [], custom: '' };
      return <fieldset key={question.id} disabled={sending}><legend>{question.question}</legend>{question.detail !== '' && <p className="muted">{question.detail}</p>}
        {question.options.map(option => <label className="question-option" key={option.label}><input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${item.id}:${question.id}`} checked={value.selected.includes(option.label)} onChange={event => {
          const selected = question.multiSelect ? event.target.checked ? [...value.selected, option.label] : value.selected.filter(label => label !== option.label) : [option.label];
          setAnswers({ ...answers, [question.id]: { ...value, selected } });
        }} /><span>{option.label}{option.description !== '' && <small>{option.description}</small>}</span></label>)}
        {!question.fixedApproval && <input value={value.custom} maxLength={8192} placeholder="自定义回答" aria-label={`${question.question} 自定义回答`} onChange={event => setAnswers({ ...answers, [question.id]: { ...value, custom: event.target.value } })} />}
      </fieldset>;
    })}
    <div className="pending-actions">
      {item.kind === 'approval' && item.choices.map(choice => <button type="button" key={choice.id} disabled={sending} className={choice.id === 'allowed-once' ? 'primary' : ''} onClick={() => answer(choice.id)}>{choice.label}</button>)}
      {item.kind === 'question' && <button type="button" className="primary" disabled={sending} onClick={() => answer(JSON.stringify({ answers: item.questions.map(question => {
        const value = answers[question.id] ?? { selected: [], custom: '' };
        return { id: question.id, selected: value.selected, ...(value.custom.trim() === '' ? {} : { custom: value.custom }) };
      }) }))}>提交回答</button>}
      <button type="button" disabled={sending} onClick={() => { void store.action(store.api.openFallback(context.serverId)); }}>兼容网页</button>
      {item.kind === 'unsupported' && <button type="button" disabled={sending} onClick={() => answer('__delegate__')}>交还原站点处理</button>}
    </div>
  </section>;
}
