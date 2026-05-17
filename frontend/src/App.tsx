import { FormEvent, useEffect, useMemo, useState } from "react";
import { getAgentModes, sendCopilotAction, sendCopilotChat } from "./api/copilotClient";
import type {
  AgentModesResponse,
  CopilotChatResponse,
  CopilotMessage,
  CopilotWorkspace,
  ProductAction,
  ProductTimelineItem,
  ProductVariant,
} from "./types/copilot";

const defaultResume = "As a Frontend Engineer at Acme Corp, I built React and TypeScript systems and reduced bundle size by 40%.";
const defaultJd = "Looking for a Frontend Engineer with React, TypeScript, performance optimization and design system experience.";
const quickPrompts = [
  "帮我根据 JD 改写项目经历",
  "帮我把这段经历写得更量化",
  "帮我检查这段经历是否夸大",
  "帮我生成更保守的版本",
];

type ContextState = {
  targetRole: string;
  resumeText: string;
  jdText: string;
};

type UIMessage = CopilotMessage & {
  actions?: ProductAction[];
};

type PendingAction = {
  action: ProductAction;
  values: Record<string, string>;
};

const initialContext: ContextState = {
  targetRole: "Frontend Engineer",
  resumeText: defaultResume,
  jdText: defaultJd,
};

function App() {
  const [context, setContext] = useState<ContextState>(initialContext);
  const [contextDraft, setContextDraft] = useState<ContextState>(initialContext);
  const [isContextOpen, setIsContextOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [sessionId, setSessionId] = useState<string>();
  const [turnId, setTurnId] = useState<string>();
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [workspace, setWorkspace] = useState<CopilotWorkspace>();
  const [timeline, setTimeline] = useState<ProductTimelineItem[]>([]);
  const [agentModes, setAgentModes] = useState<AgentModesResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [pendingAction, setPendingAction] = useState<PendingAction>();

  useEffect(() => {
    getAgentModes()
      .then(setAgentModes)
      .catch((err) => setError(readError(err)));
  }, []);

  const activeVariantId = workspace?.activeVariantId ?? workspace?.variants[0]?.id;
  const debugIds = useMemo(() => ({
    sessionId,
    turnId,
    workspaceId: workspace?.id,
    artifactIds: workspace?.variants.map((variant) => variant.artifactId).filter(Boolean) ?? [],
    variantIds: workspace?.variants.map((variant) => variant.id) ?? [],
  }), [sessionId, turnId, workspace]);

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;

    setMessages((current) => [...current, makeLocalMessage("user", trimmedMessage, sessionId)]);
    setMessage("");
    setLoading(true);
    setError(undefined);

    try {
      const response = await sendCopilotChat({
        sessionId,
        message: trimmedMessage,
        resumeText: context.resumeText,
        jdText: context.jdText,
        targetRole: context.targetRole,
        clientState: {
          activeVariantId,
          selectedSection: "chat",
          locale: "zh-CN",
        },
      });
      applyChatResponse(response, "replace");
    } catch (err) {
      const errorMessage = readError(err);
      setError(errorMessage);
      setMessages((current) => [...current, makeLocalMessage("system", errorMessage, sessionId)]);
    } finally {
      setLoading(false);
    }
  }

  function openContext() {
    setContextDraft(context);
    setIsContextOpen(true);
  }

  function saveContext(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setContext(contextDraft);
    setIsContextOpen(false);
  }

  function startAction(action: ProductAction) {
    if (action.inputSchema?.fields.length) {
      const values = Object.fromEntries(action.inputSchema.fields.map((field) => [field.key, ""]));
      setPendingAction({ action, values });
      return;
    }
    void submitAction(action);
  }

  async function submitAction(action: ProductAction, payload?: Record<string, unknown>) {
    if (!sessionId) {
      setError("请先发送一条消息，再使用操作按钮。");
      return;
    }

    setLoading(true);
    setError(undefined);
    try {
      const response = await sendCopilotAction({
        sessionId,
        turnId,
        action: {
          type: action.type,
          variantId: action.variantId,
          payload,
        },
        clientState: {
          activeVariantId,
          selectedSection: "chat",
          locale: "zh-CN",
        },
      });
      applyChatResponse(response, "append");
    } catch (err) {
      const errorMessage = readError(err);
      setError(errorMessage);
      setMessages((current) => [...current, makeLocalMessage("system", errorMessage, sessionId)]);
    } finally {
      setLoading(false);
    }
  }

  function applyChatResponse(response: CopilotChatResponse, timelineMode: "replace" | "append") {
    setSessionId(response.sessionId);
    setTurnId(response.turnId);
    setMessages((current) => [...current, { ...response.assistantMessage, actions: response.nextActions }]);
    setWorkspace((current) => (
      response.workspace.variants.length > 0 || !current ? response.workspace : current
    ));
    setTimeline((current) => (
      timelineMode === "replace" ? response.timeline : appendTimeline(current, response.timeline)
    ));
  }

  function submitPendingAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingAction) return;
    const payload = Object.fromEntries(
      Object.entries(pendingAction.values).filter(([, value]) => value.trim().length > 0),
    );
    const action = pendingAction.action;
    setPendingAction(undefined);
    void submitAction(action, payload);
  }

  return (
    <main className="app-shell">
      <section className="chat-panel">
        <header className="panel-header">
          <div>
            <h1>Coolto Copilot</h1>
            <p>像聊天一样生成、比较和修订你的简历经历版本。</p>
          </div>
          <AgentModesBar agentModes={agentModes} />
        </header>

        <div className="messages" aria-live="polite">
          {messages.length === 0 ? (
            <WelcomeCard onPrompt={setMessage} onOpenContext={openContext} />
          ) : messages.map((item) => (
            <ChatMessage key={item.id} message={item} onAction={startAction} disabled={loading || !sessionId} />
          ))}
          {loading ? <div className="typing">Coolto 正在思考...</div> : null}
          {error ? <div className="error-note">{error}</div> : null}
        </div>

        <form className="chat-composer" onSubmit={handleSend}>
          <ContextChips context={context} />
          <div className="composer-box">
            <button className="context-button" type="button" onClick={openContext}>+ 添加上下文</button>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="告诉 Copilot 你想怎么改写，例如：请根据我的简历和 JD 生成适合投递的项目经历改写版本。"
              rows={2}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button className="send-button" type="submit" disabled={loading || !message.trim()}>
              {loading ? "发送中" : "发送"}
            </button>
          </div>
        </form>
      </section>

      <section className="workspace-panel">
        <header className="workspace-header">
          <div>
            <h2>工作台</h2>
            <p>{workspace?.summary ?? "生成后的候选版本会显示在这里。"}</p>
          </div>
          <StatusPill value={workspace?.status ?? "empty"} />
        </header>

        <Timeline items={timeline} />
        <VariantList variants={workspace?.variants ?? []} onAction={startAction} disabled={loading} />

        <details className="debug-ids">
          <summary>调试 IDs</summary>
          <pre>{JSON.stringify(debugIds, null, 2)}</pre>
        </details>
      </section>

      {isContextOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form className="modal context-modal" onSubmit={saveContext}>
            <div>
              <h3>上下文</h3>
              <p>简历、JD 和目标岗位会随下一次消息发送给 Copilot。</p>
            </div>
            <label>
              目标岗位
              <input
                value={contextDraft.targetRole}
                onChange={(event) => setContextDraft((current) => ({ ...current, targetRole: event.target.value }))}
              />
            </label>
            <label>
              简历文本
              <textarea
                value={contextDraft.resumeText}
                onChange={(event) => setContextDraft((current) => ({ ...current, resumeText: event.target.value }))}
                rows={8}
              />
            </label>
            <label>
              JD 文本
              <textarea
                value={contextDraft.jdText}
                onChange={(event) => setContextDraft((current) => ({ ...current, jdText: event.target.value }))}
                rows={8}
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setIsContextOpen(false)}>取消</button>
              <button className="primary-button" type="submit">保存上下文</button>
            </div>
          </form>
        </div>
      ) : null}

      {pendingAction ? (
        <div className="modal-backdrop" role="presentation">
          <form className="modal" onSubmit={submitPendingAction}>
            <h3>{actionLabel(pendingAction.action)}</h3>
            {pendingAction.action.inputSchema?.fields.map((field) => (
              <label key={field.key}>
                {fieldLabel(field.key, field.label)}
                {field.type === "textarea" ? (
                  <textarea
                    placeholder={field.placeholder}
                    required={field.required}
                    rows={3}
                    value={pendingAction.values[field.key] ?? ""}
                    onChange={(event) => setPendingAction((current) => current && ({
                      ...current,
                      values: { ...current.values, [field.key]: event.target.value },
                    }))}
                  />
                ) : (
                  <input
                    type={field.type}
                    placeholder={field.placeholder}
                    required={field.required}
                    value={pendingAction.values[field.key] ?? ""}
                    onChange={(event) => setPendingAction((current) => current && ({
                      ...current,
                      values: { ...current.values, [field.key]: event.target.value },
                    }))}
                  />
                )}
              </label>
            ))}
            <div className="modal-actions">
              <button type="button" onClick={() => setPendingAction(undefined)}>取消</button>
              <button className="primary-button" type="submit">提交</button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}

function AgentModesBar({ agentModes }: { agentModes?: AgentModesResponse }) {
  if (!agentModes) return <div className="mode-bar">API 状态加载中...</div>;
  return (
    <div className="mode-bar">
      <span>provider {agentModes.provider}</span>
      <span>runtime {agentModes.runtimeMode}</span>
      <span>front desk {agentModes.frontDeskMode}</span>
      <span>generator {agentModes.artifactGeneratorMode}</span>
      <span>db {agentModes.database}</span>
    </div>
  );
}

function WelcomeCard({ onPrompt, onOpenContext }: { onPrompt: (prompt: string) => void; onOpenContext: () => void }) {
  return (
    <div className="welcome-card">
      <div className="assistant-mark">C</div>
      <div>
        <h2>你好，我是 Coolto Copilot。</h2>
        <p>
          你可以直接告诉我要投递的岗位，也可以先添加简历和 JD。我会帮你生成多个可选择的简历经历版本，并解释每个版本的证据和风险。
        </p>
      </div>
      <div className="quick-prompts">
        {quickPrompts.map((prompt) => (
          <button key={prompt} type="button" onClick={() => onPrompt(prompt)}>{prompt}</button>
        ))}
      </div>
      <button className="context-inline" type="button" onClick={onOpenContext}>添加或查看上下文</button>
    </div>
  );
}

function ContextChips({ context }: { context: ContextState }) {
  return (
    <div className="context-chips">
      <span className={context.resumeText.trim() ? "context-chip context-ready" : "context-chip"}>
        简历 {context.resumeText.trim() ? `已添加 · ${context.resumeText.trim().length} 字` : "未添加"}
      </span>
      <span className={context.jdText.trim() ? "context-chip context-ready" : "context-chip"}>
        JD {context.jdText.trim() ? `已添加 · ${context.jdText.trim().length} 字` : "未添加"}
      </span>
      <span className="context-chip context-ready">目标岗位 {context.targetRole || "未设置"}</span>
    </div>
  );
}

function ChatMessage({
  message,
  onAction,
  disabled,
}: {
  message: UIMessage;
  onAction: (action: ProductAction) => void;
  disabled: boolean;
}) {
  return (
    <article className={`message message-${message.role}`}>
      <div className="message-meta">
        {message.role === "user" ? "你" : message.role === "assistant" ? "Coolto" : "提示"}
        {message.role === "assistant" && message.kind !== "plain_text" ? <span>{kindLabel(message.kind)}</span> : null}
      </div>
      <div className="message-content">{message.content}</div>
      {message.actions && message.actions.length > 0 ? (
        <ActionButtons actions={message.actions} onAction={onAction} disabled={disabled} className="message-actions" />
      ) : null}
    </article>
  );
}

function ActionButtons({
  actions,
  onAction,
  disabled,
  className = "",
}: {
  actions: ProductAction[];
  onAction: (action: ProductAction) => void;
  disabled: boolean;
  className?: string;
}) {
  return (
    <div className={`action-row ${className}`}>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className={action.primary ? "action-button action-primary" : "action-button"}
          disabled={disabled}
          onClick={() => onAction(action)}
        >
          {actionLabel(action)}
        </button>
      ))}
    </div>
  );
}

function Timeline({ items }: { items: ProductTimelineItem[] }) {
  return (
    <details className="timeline">
      <summary>
        <span>过程</span>
        <strong>{items.length}</strong>
      </summary>
      {items.length === 0 ? <p className="muted">暂无过程记录。</p> : (
        <ol>
          {items.map((item) => (
            <li key={item.id}>
              <span className={`dot dot-${item.status}`} />
              <div>
                <strong>{timelineTitle(item)}</strong>
                <span>{timelineTypeLabel(item.type)}</span>
                {item.description ? <p>{item.description}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

function VariantList({
  variants,
  onAction,
  disabled,
}: {
  variants: ProductVariant[];
  onAction: (action: ProductAction) => void;
  disabled: boolean;
}) {
  if (variants.length === 0) {
    return <div className="empty-workspace">还没有候选版本。发送消息后，结果会出现在这里。</div>;
  }
  return (
    <div className="variant-list">
      {variants.map((variant) => (
        <VariantCard key={variant.id} variant={variant} onAction={onAction} disabled={disabled} />
      ))}
    </div>
  );
}

function VariantCard({
  variant,
  onAction,
  disabled,
}: {
  variant: ProductVariant;
  onAction: (action: ProductAction) => void;
  disabled: boolean;
}) {
  return (
    <article className={`variant-card variant-${variant.status} role-${variant.role}`}>
      <div className="variant-topline">
        <div>
          <div className="badge-row">
            <span className="badge role-badge">{roleLabel(variant.role)}</span>
            <StatusPill value={variant.status} />
          </div>
          <h3>{variant.title}</h3>
        </div>
        <ScoreStrip variant={variant} />
      </div>

      <p className="variant-content">{variant.content}</p>
      <p className="reason">{variant.reason}</p>

      <details className="variant-detail">
        <summary>证据</summary>
        <p>{variant.evidenceSummary.coverageLabel}</p>
      </details>

      <details className="variant-detail">
        <summary>风险 <strong className={`risk-${variant.riskSummary.level}`}>{riskLabel(variant.riskSummary.level)}</strong></summary>
        {variant.riskSummary.warnings.length > 0 ? (
          <ul>
            {variant.riskSummary.warnings.map((item) => <li key={item}>{item}</li>)}
          </ul>
        ) : <p>当前风险等级：{riskLabel(variant.riskSummary.level)}</p>}
      </details>

      {variant.missingInfo.length > 0 ? (
        <div className="missing-info">
          <strong>需要确认</strong>
          <ul>
            {variant.missingInfo.slice(0, 3).map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ) : null}

      <ActionButtons actions={variant.actions} onAction={onAction} disabled={disabled} />
    </article>
  );
}

function ScoreStrip({ variant }: { variant: ProductVariant }) {
  const scores = [
    ["匹配", variant.score.overall],
    ["相关", variant.score.relevance],
    ["证据", variant.score.evidenceStrength],
  ] as const;
  return (
    <div className="scores">
      {scores.map(([label, value]) => value === undefined ? null : (
        <span key={label}>{label} {Math.round(value * 100)}%</span>
      ))}
    </div>
  );
}

function StatusPill({ value }: { value: string }) {
  return <span className={`status-pill status-${value}`}>{statusLabel(value)}</span>;
}

function appendTimeline(current: ProductTimelineItem[], next: ProductTimelineItem[]) {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...next.filter((item) => !seen.has(item.id))];
}

function makeLocalMessage(role: "user" | "system", content: string, currentSessionId?: string): UIMessage {
  return {
    id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sessionId: currentSessionId ?? "pending",
    role,
    content,
    kind: "plain_text",
    createdAt: new Date().toISOString(),
  };
}

function actionLabel(action: ProductAction) {
  const labels: Record<ProductAction["type"], string> = {
    accept: "采用",
    reject: "放弃",
    prefer: "设为首选",
    confirm_metric: "确认指标",
    revise_more_conservative: "更保守",
    revise_more_quantified: "更量化",
    show_evidence: "查看证据",
    explain_choice: "为什么推荐？",
  };
  return labels[action.type] ?? action.label;
}

function fieldLabel(key: string, fallback: string) {
  const labels: Record<string, string> = {
    metric: "指标名称",
    value: "指标数值",
    explanation: "说明",
  };
  return labels[key] ?? fallback;
}

function kindLabel(kind: CopilotMessage["kind"]) {
  const labels: Record<CopilotMessage["kind"], string> = {
    plain_text: "回复",
    resume_feedback: "反馈",
    variant_suggestion: "候选版本",
    evidence_explanation: "证据说明",
    decision_summary: "操作结果",
    clarifying_question: "补充问题",
  };
  return labels[kind];
}

function statusLabel(value: string) {
  const labels: Record<string, string> = {
    empty: "空",
    ready: "可用",
    generating: "生成中",
    awaiting_user_decision: "待决策",
    accepted: "已采用",
    revision_needed: "需修订",
    needs_confirmation: "需确认",
    unsafe: "高风险",
    rejected: "已放弃",
  };
  return labels[value] ?? value.replace(/_/g, " ");
}

function roleLabel(value: ProductVariant["role"]) {
  const labels: Record<ProductVariant["role"], string> = {
    recommended: "推荐",
    alternative: "备选",
    safe: "稳妥",
    quantified: "量化",
    experimental: "实验版",
  };
  return labels[value];
}

function riskLabel(value: string) {
  const labels: Record<string, string> = {
    low: "低",
    medium: "中",
    high: "高",
  };
  return labels[value] ?? value;
}

function timelineTypeLabel(value: ProductTimelineItem["type"]) {
  const labels: Record<ProductTimelineItem["type"], string> = {
    message_received: "收到消息",
    resume_ingested: "简历处理",
    jd_analyzed: "JD 分析",
    variants_generated: "生成候选",
    critique_completed: "完成审查",
    revision_completed: "完成修订",
    decision_recorded: "记录决策",
    evidence_opened: "查看证据",
    warning: "提醒",
  };
  return labels[value];
}

function timelineTitle(item: ProductTimelineItem) {
  if (item.type === "variants_generated") return item.title.replace("variants generated", "个候选版本已生成");
  if (item.type === "critique_completed") return "审查完成";
  if (item.type === "message_received") return "消息已收到";
  return item.title;
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : "发生错误，请稍后重试。";
}

export default App;
