"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ActivityEntry {
  id: number;
  tool_name: string;
  arguments: string;
  status: "success" | "error";
  result: string | null;
  created_at: string;
}

const ACTIVITY_POLL_MS = 5000;

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  function refreshActivity() {
    fetch("/api/activity")
      .then((res) => res.json())
      .then(setActivity)
      .catch(() => {
        // Non-critical -- the chat still works without the activity panel.
      });
  }

  useEffect(() => {
    fetch("/api/chat")
      .then((res) => res.json())
      .then((rows: { role: "user" | "assistant"; content: string }[]) =>
        setMessages(rows.map((r) => ({ role: r.role, content: r.content })))
      )
      .catch(() => {
        // No history yet, or DB not reachable -- start with an empty chat.
      });

    refreshActivity();
    const interval = setInterval(refreshActivity, ACTIVITY_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;

    setInput("");
    setSending(true);
    setMessages((prev) => [...prev, { role: "user", content: text }, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      if (!res.body) throw new Error("No response stream from server");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = {
            role: "assistant",
            content: next[next.length - 1].content + chunk,
          };
          return next;
        });
      }
    } catch (err) {
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "assistant",
          content: `[Connection trouble, sir: ${err instanceof Error ? err.message : String(err)}]`,
        };
        return next;
      });
    } finally {
      setSending(false);
      refreshActivity(); // any tool calls made during this reply show up now
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>PATTSON</h1>
      </header>

      <div className={styles.body}>
        <main className={styles.chat}>
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? styles.userMsg : styles.assistantMsg}>
              <span className={styles.msgRole}>{m.role === "user" ? "You" : "PATTSON"}</span>
              <p>{m.content || (sending && i === messages.length - 1 ? "…" : "")}</p>
            </div>
          ))}
          <div ref={bottomRef} />
        </main>

        <aside className={styles.activityPanel}>
          <h2>Recent activity</h2>
          {activity.length === 0 && <p className={styles.activityEmpty}>Nothing yet.</p>}
          <ul>
            {activity.map((a) => (
              <li key={a.id} className={a.status === "error" ? styles.activityError : styles.activityOk}>
                <div className={styles.activityHead}>
                  <span>{a.tool_name}</span>
                  <span className={styles.activityStatus}>{a.status}</span>
                </div>
                <time>{a.created_at}</time>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <form
        className={styles.inputBar}
        onSubmit={(e) => {
          e.preventDefault();
          sendMessage();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Talk to Pattson..."
          disabled={sending}
        />
        <button type="submit" disabled={sending || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
