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

const defaultMessage = "请根据我的简历和 JD，生成适合投递的项目经历改写版本。";
const defaultResume = "As a Frontend Engineer at Acme Corp, I built React and TypeScript systems and reduced bundle size by 40%.";
const defaultJd = "Looking for a Frontend Engineer with React, TypeScript, performance optimization and design system experience.";

type PendingAction = {
  action: ProductAction;
  values: Record<string, string>;
};

function App() {
  const [targetRole, setTargetRole] = useState("Frontend Engineer");
  const [resumeText, setResumeText] = useState(defaultResume);
  const [jdText, setJdText] = useState(defaultJd);
  const [message, setMessage] = useState(defaultMessage);
  const [sessionId, setSessionId] = useState<string>();
  const [turnId, setTurnId] = useState<string>();
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [workspace, setWorkspace] = useState<CopilotWorkspace>();
  const [timeline, setTimeline] = useState<ProductTimelineItem[]>([]);
  const [nextActions, setNextActions] = useState<ProductAction[]>([]);
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
  const rawIds = useMemo(() => ({
    sessionId,
    turnId,
    workspaceId: workspace?.id,
    variants: workspace?.variants.map((variant) => ({
      id: variant.id,
      artifactId: variant.artifactId,
      sourceEvidenceIds: variant.sourceEvidenceIds,
    })) ?? [],
  }), [sessionId, turnId, workspace]);

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim()) return;

    const userMessage = makeLocalMessage("user", message.trim(), sessionId);
    setMessages((current) => [...current, userMessage]);
    setLoading(true);
    setError(undefined);

    try {
      const response = await sendCopilotChat({
        sessionId,
        message: message.trim(),
        resumeText,
        jdText,
        targetRole,
        clientState: {
          activeVariantId,
          selectedSection: "workspace",
        },
      });
      applyChatResponse(response, "replace");
    } catch (err) {
      setError(readError(err));
      setMessages((current) => [...current, makeLocalMessage("system", readError(err), sessionId)]);
    } finally {
      setLoading(false);
    }
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
      setError("Send a chat message before using actions.");
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
        },
      });
      applyChatResponse(response, "append");
    } catch (err) {
      setError(readError(err));
      setMessages((current) => [...current, makeLocalMessage("system", readError(err), sessionId)]);
    } finally {
      setLoading(false);
    }
  }

  function applyChatResponse(response: CopilotChatResponse, timelineMode: "replace" | "append") {
    setSessionId(response.sessionId);
    setTurnId(response.turnId);
    setMessages((current) => [...current, response.assistantMessage]);
    setWorkspace((current) => (
      response.workspace.variants.length > 0 || !current ? response.workspace : current
    ));
    setTimeline((current) => (
      timelineMode === "replace" ? response.timeline : appendTimeline(current, response.timeline)
    ));
    setNextActions(response.nextActions);
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
            <p>Chat with the resume copilot and review generated variants.</p>
          </div>
          <AgentModesBar agentModes={agentModes} />
        </header>

        <div className="messages" aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty-state">
              Paste a resume and JD, then send a request to generate workspace variants.
            </div>
          ) : messages.map((item) => (
            <article key={item.id} className={`message message-${item.role}`}>
              <div className="message-meta">{item.role === "user" ? "You" : item.kind.replace(/_/g, " ")}</div>
              <div className="message-content">{item.content}</div>
            </article>
          ))}
          {loading ? <div className="typing">Working...</div> : null}
          {error ? <div className="error-note">{error}</div> : null}
        </div>

        <form className="composer" onSubmit={handleSend}>
          <TopActions actions={nextActions} onAction={startAction} disabled={loading || !sessionId} />
          <label>
            Target role
            <input value={targetRole} onChange={(event) => setTargetRole(event.target.value)} />
          </label>
          <details className="resume-details" open>
            <summary>Resume text</summary>
            <textarea value={resumeText} onChange={(event) => setResumeText(event.target.value)} rows={4} />
          </details>
          <label>
            Job description
            <textarea value={jdText} onChange={(event) => setJdText(event.target.value)} rows={4} />
          </label>
          <label>
            Message
            <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} />
          </label>
          <div className="composer-footer">
            <span>{sessionId ? `Session ${shortId(sessionId)}` : "New session"}</span>
            <button className="primary-button" type="submit" disabled={loading || !message.trim()}>
              {loading ? "Sending" : "Send"}
            </button>
          </div>
        </form>
      </section>

      <section className="workspace-panel">
        <header className="workspace-header">
          <div>
            <h2>Workspace</h2>
            <p>{workspace?.summary ?? "Variants will appear here after generation."}</p>
          </div>
          <StatusPill value={workspace?.status ?? "empty"} />
        </header>

        <Timeline items={timeline} />
        <VariantList variants={workspace?.variants ?? []} onAction={startAction} disabled={loading} />

        <details className="debug-ids">
          <summary>Debug ids</summary>
          <pre>{JSON.stringify(rawIds, null, 2)}</pre>
        </details>
      </section>

      {pendingAction ? (
        <div className="modal-backdrop" role="presentation">
          <form className="modal" onSubmit={submitPendingAction}>
            <h3>{pendingAction.action.label}</h3>
            {pendingAction.action.inputSchema?.fields.map((field) => (
              <label key={field.key}>
                {field.label}
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
              <button type="button" onClick={() => setPendingAction(undefined)}>Cancel</button>
              <button className="primary-button" type="submit">Submit</button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}

function AgentModesBar({ agentModes }: { agentModes?: AgentModesResponse }) {
  if (!agentModes) return <div className="mode-bar">API status loading...</div>;
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

function TopActions({
  actions,
  onAction,
  disabled,
}: {
  actions: ProductAction[];
  onAction: (action: ProductAction) => void;
  disabled: boolean;
}) {
  if (actions.length === 0) return null;
  return (
    <div className="top-actions">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className={action.primary ? "action-button action-primary" : "action-button"}
          disabled={disabled}
          onClick={() => onAction(action)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

function Timeline({ items }: { items: ProductTimelineItem[] }) {
  return (
    <section className="timeline">
      <h3>Timeline</h3>
      {items.length === 0 ? <p className="muted">No activity yet.</p> : (
        <ol>
          {items.map((item) => (
            <li key={item.id}>
              <span className={`dot dot-${item.status}`} />
              <div>
                <strong>{item.title}</strong>
                <span>{item.type.replace(/_/g, " ")}</span>
                {item.description ? <p>{item.description}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
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
    return <div className="empty-workspace">No variants yet.</div>;
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
          <h3>{variant.title}</h3>
          <div className="badge-row">
            <span className="badge role-badge">{variant.role}</span>
            <StatusPill value={variant.status} />
          </div>
        </div>
        <ScoreStrip variant={variant} />
      </div>

      <p className="variant-content">{variant.content}</p>
      <p className="reason">{variant.reason}</p>

      <div className="evidence-box">
        <strong>Evidence</strong>
        <span>{variant.evidenceSummary.coverageLabel}</span>
      </div>

      <div className="risk-row">
        <span>Risk</span>
        <strong className={`risk-${variant.riskSummary.level}`}>{variant.riskSummary.level}</strong>
      </div>

      {variant.missingInfo.length > 0 ? (
        <div className="missing-info">
          <strong>Needs confirmation</strong>
          <ul>
            {variant.missingInfo.slice(0, 3).map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ) : null}

      <div className="variant-actions">
        {variant.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={action.primary ? "action-button action-primary" : "action-button"}
            disabled={disabled}
            onClick={() => onAction(action)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </article>
  );
}

function ScoreStrip({ variant }: { variant: ProductVariant }) {
  const scores = [
    ["Overall", variant.score.overall],
    ["Relevance", variant.score.relevance],
    ["Evidence", variant.score.evidenceStrength],
  ] as const;
  return (
    <div className="scores">
      {scores.map(([label, value]) => value === undefined ? null : (
        <div key={label}>
          <span>{label}</span>
          <strong>{Math.round(value * 100)}%</strong>
        </div>
      ))}
    </div>
  );
}

function StatusPill({ value }: { value: string }) {
  return <span className={`status-pill status-${value}`}>{value.replace(/_/g, " ")}</span>;
}

function appendTimeline(current: ProductTimelineItem[], next: ProductTimelineItem[]) {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...next.filter((item) => !seen.has(item.id))];
}

function makeLocalMessage(role: "user" | "system", content: string, currentSessionId?: string): CopilotMessage {
  return {
    id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sessionId: currentSessionId ?? "pending",
    role,
    content,
    kind: "plain_text",
    createdAt: new Date().toISOString(),
  };
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function shortId(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

export default App;
