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

interface MemoryEntry {
  id: number;
  content: string;
  created_at: string;
}

interface PattsonSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: { transcript: string };
}

interface PattsonSpeechRecognitionResultList {
  readonly length: number;
  [index: number]: PattsonSpeechRecognitionResult;
}

interface PattsonSpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: PattsonSpeechRecognitionResultList;
}

interface PattsonSpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: PattsonSpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
}

type PattsonSpeechRecognitionCtor = new () => PattsonSpeechRecognition;

type OrbState = "standby" | "listening" | "thinking" | "speaking";

const ACTIVITY_POLL_MS = 5000;

const ORB_STATE_CLASS: Record<OrbState, string> = {
  standby: styles.stageStandby,
  listening: styles.stageListening,
  thinking: styles.stageThinking,
  speaking: styles.stageSpeaking,
};

const ORB_STATE_LABEL: Record<OrbState, string> = {
  standby: "Standby",
  listening: "Listening",
  thinking: "Processing",
  speaking: "Speaking",
};

function getSpeechRecognitionCtor(): PattsonSpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: PattsonSpeechRecognitionCtor;
    webkitSpeechRecognition?: PattsonSpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const FEMALE_VOICE_NAME = /female|\b(susan|hazel|zira|samantha|victoria|karen|moira|tessa|fiona|serena|kate|amy|emma|joanna|salli|kimberly|sonia|libby)\b/i;
const MALE_VOICE_NAME = /male|\b(daniel|george|ryan|arthur|oliver|james|david|mark|alex|fred|thomas|brian|matthew|justin|eric)\b/i;
// Windows 11 / Chrome now surface cloud-backed "Online (Natural)" voices
// (e.g. "Microsoft Ryan Online (Natural)") alongside the old offline SAPI
// ones ("Microsoft David Desktop") -- the former are dramatically less
// robotic. "Neural"/"Premium"/"Enhanced" cover the equivalent naming on
// other platforms (Google/Android, macOS). Free -- still just the browser's
// own voice list, only ranked smarter instead of taking the first match.
const QUALITY_VOICE_NAME = /natural|neural|premium|enhanced/i;

function pickBritishVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;

  function score(v: SpeechSynthesisVoice): number {
    let s = 0;
    if (QUALITY_VOICE_NAME.test(v.name)) s += 4;
    if (/en[-_]GB/i.test(v.lang)) s += 2;
    if (MALE_VOICE_NAME.test(v.name) && !FEMALE_VOICE_NAME.test(v.name)) s += 1;
    return s;
  }

  const ranked = [...voices].sort((a, b) => score(b) - score(a));
  return ranked[0] ?? voices.find((v) => v.default) ?? null;
}

// Short ALL-CAPS tokens (2-4 letters) are a classic TTS trap -- engines
// often treat them as acronyms and spell them out letter by letter. If
// Claude ever writes "PAT" in caps, normalize it back to a mixed-case word
// so it reads as a name, not an initialism.
function toSpeechText(text: string): string {
  return text.replace(/\bPAT\b/g, "Pat");
}

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// On speaker-and-mic setups (no headphones), the mic can pick up Pat's own
// voice the instant it starts listening again. If the fresh transcript is
// basically a match for what Pat just said, treat it as feedback, not a
// real reply -- otherwise it'll happily carry on a chat with itself.
function looksLikeSelfEcho(transcript: string, lastSpoken: string): boolean {
  if (!lastSpoken) return false;
  const heard = normalizeForCompare(transcript);
  const spoken = normalizeForCompare(lastSpoken);
  if (!heard) return false;
  // Require a few words before even considering this an echo. A short,
  // legitimate reply ("yes", "go on", "what else") has a real chance of
  // coincidentally appearing as a substring inside Pat's own (usually much
  // longer) prior reply -- without this, genuine short follow-ups get
  // silently swallowed, which looks exactly like "continuous chat is broken".
  if (heard.split(" ").length < 4) return false;
  return spoken.includes(heard) || heard.includes(spoken);
}

// Wake phrase for hands-free activation -- "hello Pat" (or "hey Pat") said
// while Pat is passively listening in the background starts a real
// conversation turn. Deliberately loose (substring match on a normalized
// transcript) since speech recognition of a short phrase is noisy.
function looksLikeWakeWord(transcript: string): boolean {
  const heard = normalizeForCompare(transcript);
  return heard.includes("hello pat") || heard.includes("hey pat");
}

const WAKE_GREETING = "Hello, sir — at your service.";

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [memoryCount, setMemoryCount] = useState<number | null>(null);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voiceOverlayOpen, setVoiceOverlayOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLSpanElement | null>(null);
  const recognitionRef = useRef<PattsonSpeechRecognition | null>(null);
  const wakeRecognitionRef = useRef<PattsonSpeechRecognition | null>(null);
  const voiceModeRef = useRef(voiceMode);
  const sendingRef = useRef(sending);
  const listeningRef = useRef(listening);
  const stopRequestedRef = useRef(false);
  const lastSpokenRef = useRef("");
  const autoRestartTimeoutRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingOriginalTextRef = useRef("");
  const activeRequestIdRef = useRef(0);
  const speakingRef = useRef(speaking);
  const bargeInRecognitionRef = useRef<PattsonSpeechRecognition | null>(null);

  const orbState: OrbState = listening ? "listening" : speaking ? "speaking" : sending ? "thinking" : "standby";

  useEffect(() => {
    setVoiceSupported(getSpeechRecognitionCtor() !== null && typeof window.speechSynthesis !== "undefined");
  }, []);

  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

  useEffect(() => {
    listeningRef.current = listening;
  }, [listening]);

  useEffect(() => {
    speakingRef.current = speaking;
  }, [speaking]);

  function refreshActivity() {
    fetch("/api/activity")
      .then((res) => res.json())
      .then(setActivity)
      .catch(() => {
        // Non-critical -- the chat still works without the activity panel.
      });
    fetch("/api/memory")
      .then((res) => res.json())
      .then((data: { count: number; memories: MemoryEntry[] }) => {
        setMemoryCount(data.count);
        setMemories(data.memories);
      })
      .catch(() => {
        // Non-critical -- just the sidebar count and management panel.
      });
  }

  function deleteMemory(id: number) {
    // Optimistic: the panel is a quick management tool, not a form -- drop
    // it from view immediately, then let refreshActivity reconcile with the
    // server on the next poll (or right away, below) if anything mismatches.
    setMemories((prev) => prev.filter((m) => m.id !== id));
    setMemoryCount((prev) => (prev === null ? prev : Math.max(0, prev - 1)));
    fetch(`/api/memory/${id}`, { method: "DELETE" })
      .then(() => refreshActivity())
      .catch(() => {
        refreshActivity(); // resync in case the optimistic removal was wrong
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

  useEffect(() => {
    if (!voiceOverlayOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeVoiceOverlay();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceOverlayOpen]);

  useEffect(() => {
    if (!memoryPanelOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMemoryPanelOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [memoryPanelOpen]);

  function stopMicMeter() {
    if (meterRafRef.current !== null) {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
    }
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    orbRef.current?.style.setProperty("--mic-level", "0");
  }

  // Makes the orb's glow track actual mic input while listening -- a second,
  // separate getUserMedia stream purely for amplitude metering (the Web
  // Speech API used for recognition doesn't expose audio levels). Written
  // straight to the orb's own CSS custom property via a ref on every frame,
  // bypassing React state entirely, so this doesn't trigger a re-render 60
  // times a second.
  async function startMicMeter() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const AudioContextCtor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return;

      const ctx = new AudioContextCtor();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!audioCtxRef.current) return;
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const level = Math.min(1, (sum / data.length / 255) * 3.2);
        orbRef.current?.style.setProperty("--mic-level", level.toFixed(3));
        meterRafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // Purely a visual nicety -- if mic metering fails for any reason,
      // listening itself (SpeechRecognition, started separately) still
      // works fine without the reactive glow.
    }
  }

  function clearPendingAutoRestart() {
    if (autoRestartTimeoutRef.current !== null) {
      window.clearTimeout(autoRestartTimeoutRef.current);
      autoRestartTimeoutRef.current = null;
    }
  }

  function stopSpeaking() {
    stopRequestedRef.current = true;
    clearPendingAutoRestart();
    stopBargeInListener();
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }

  // The user-facing "Stop" button: silence Pat, then fall back to passive
  // wake-word listening rather than leaving the overlay open with nothing
  // happening (stopSpeaking alone is also reused by closeVoiceOverlay,
  // where restarting the wake listener would be wrong -- so that part lives
  // here, not in stopSpeaking itself).
  function handleStopButton() {
    stopSpeaking();
    if (voiceModeRef.current) {
      setVoiceOverlayOpen(false);
      startWakeListener();
    }
  }

  function stopWakeListener() {
    wakeRecognitionRef.current?.stop();
    wakeRecognitionRef.current = null;
  }

  // Passive, continuous background listener for "hello Pat" -- runs whenever
  // voice mode is on and nothing else is happening. On the wake phrase, it
  // hands off to a real, active listening turn via startListening. If the
  // browser ends the recognition on its own (some implementations time out
  // even with continuous:true), it just restarts itself, so it keeps
  // listening for the wake phrase indefinitely while voice mode is on.
  function startWakeListener() {
    if (!voiceModeRef.current || listeningRef.current || sendingRef.current) return;
    if (wakeRecognitionRef.current) return;

    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) return;

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "en-GB";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      if (looksLikeWakeWord(transcript)) {
        recognition.stop();
        wakeRecognitionRef.current = null;
        setVoiceOverlayOpen(true);
        setMessages((prev) => [...prev, { role: "assistant", content: WAKE_GREETING }]);
        speak(WAKE_GREETING);
      }
    };
    recognition.onerror = () => {
      if (wakeRecognitionRef.current !== recognition) return;
      wakeRecognitionRef.current = null;
      if (voiceModeRef.current && !listeningRef.current && !sendingRef.current) {
        window.setTimeout(startWakeListener, 500);
      }
    };
    recognition.onend = () => {
      if (wakeRecognitionRef.current !== recognition) return;
      wakeRecognitionRef.current = null;
      if (voiceModeRef.current && !listeningRef.current && !sendingRef.current) {
        startWakeListener();
      }
    };

    wakeRecognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // If .start() throws synchronously (e.g. InvalidStateError from
      // starting too soon after another session ended), neither onerror nor
      // onend will ever fire for this dead instance -- without this catch,
      // the wake listener just dies silently with no retry, and Voice mode
      // goes permanently quiet until the user manually re-enables it.
      wakeRecognitionRef.current = null;
      if (voiceModeRef.current && !listeningRef.current && !sendingRef.current) {
        window.setTimeout(startWakeListener, 500);
      }
    }
  }

  function stopBargeInListener() {
    bargeInRecognitionRef.current?.stop();
    bargeInRecognitionRef.current = null;
  }

  // Runs silently in the background for the whole time Pat is talking, so
  // the user can cut in mid-sentence like they would with a person instead
  // of having to wait or tap the mic. Deliberately doesn't touch `listening`
  // state -- this is a passive detector, not a real listening turn, so the
  // UI keeps showing "speaking" until a genuine barge-in is confirmed. Reuses
  // looksLikeSelfEcho against lastSpokenRef (the full reply currently being
  // read aloud) so Pat's own voice bleeding into the mic doesn't trigger it.
  function startBargeInListener() {
    if (!voiceModeRef.current || listeningRef.current || bargeInRecognitionRef.current) return;

    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) return;

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "en-GB";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      const lastResult = event.results[event.results.length - 1];
      if (!lastResult?.isFinal) return;
      if (looksLikeSelfEcho(transcript, lastSpokenRef.current)) return;

      // Genuine barge-in: cut Pat off and treat this as the next message.
      // The reply Pat was mid-sentence on is already fully saved to history
      // (streaming finished before speak() was ever called), so this is a
      // clean new turn, not an interrupt-and-restart like the thinking-phase
      // case -- there's nothing in-flight to abort or clean up.
      recognition.stop();
      bargeInRecognitionRef.current = null;
      stopSpeaking();
      sendMessage(transcript);
    };
    recognition.onerror = () => {
      if (bargeInRecognitionRef.current !== recognition) return;
      bargeInRecognitionRef.current = null;
    };
    recognition.onend = () => {
      if (bargeInRecognitionRef.current !== recognition) return;
      bargeInRecognitionRef.current = null;
      // Some implementations end a continuous session on their own even
      // with nothing detected -- restart as long as Pat is still talking.
      if (speakingRef.current && voiceModeRef.current && !listeningRef.current) {
        startBargeInListener();
      }
    };

    bargeInRecognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // If two recognition sessions can't coexist on this browser, barge-in
      // simply doesn't activate -- the user can still tap the mic manually,
      // same as before this feature existed.
      bargeInRecognitionRef.current = null;
    }
  }

  function closeVoiceOverlay() {
    voiceModeRef.current = false;
    stopSpeaking();
    recognitionRef.current?.stop();
    stopWakeListener();
    stopMicMeter();
    setVoiceMode(false);
    setVoiceOverlayOpen(false);
  }

  function speak(text: string) {
    // voiceModeRef, not the voiceMode state var: this can be called from a
    // recognition/utterance callback whose closure was captured well before
    // the current render (e.g. the wake listener set up inside the Voice
    // toggle's own onClick, before React had processed setVoiceMode) -- the
    // ref is always live regardless of which render's closure calls in.
    if (!voiceModeRef.current || !text || typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    lastSpokenRef.current = text;
    const utterance = new SpeechSynthesisUtterance(toSpeechText(text));
    const voice = pickBritishVoice();
    if (voice) utterance.voice = voice;
    // Default rate (1.0) reads slightly clipped/rushed on most engines, and
    // default pitch on the older SAPI-style voices skews thin and robotic.
    // A touch slower and a touch lower is a free, zero-latency way to sound
    // more like a measured butler than a phone menu.
    utterance.rate = 0.96;
    utterance.pitch = 0.94;
    utterance.onstart = () => {
      setSpeaking(true);
      setVoiceOverlayOpen(true);
      startBargeInListener();
    };
    utterance.onend = () => {
      setSpeaking(false);
      stopBargeInListener();
      const wasStopped = stopRequestedRef.current;
      stopRequestedRef.current = false;
      // Hands-free follow-through: once Pat finishes speaking, listen
      // again automatically so voice mode doesn't need a mic click every
      // single turn -- unless the user deliberately cut it off. A short
      // cooldown plus the self-echo check in startListening guard against
      // the mic picking up Pat's own voice off the speakers.
      if (!wasStopped && voiceModeRef.current) {
        clearPendingAutoRestart();
        autoRestartTimeoutRef.current = window.setTimeout(() => {
          autoRestartTimeoutRef.current = null;
          startListening();
        }, 800);
      }
    };
    utterance.onerror = () => {
      setSpeaking(false);
      stopBargeInListener();
      stopRequestedRef.current = false;
    };
    window.speechSynthesis.speak(utterance);
  }

  async function sendMessage(overrideText?: string) {
    const text = (overrideText ?? input).trim();
    if (!text || sendingRef.current) return;

    // Each call gets its own generation id + AbortController. If this call
    // gets superseded by an interrupt, its own finally block must not be
    // allowed to clobber the *new* call's sending state once that one has
    // taken over -- comparing against this id (not the ref/state, which the
    // new call will have already moved on) is what makes that safe.
    const requestId = ++activeRequestIdRef.current;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    pendingOriginalTextRef.current = text;

    setInput("");
    setSending(true);
    setMessages((prev) => [...prev, { role: "user", content: text }, { role: "assistant", content: "" }]);

    let replyText = "";
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, mode: voiceModeRef.current ? "voice" : "text" }),
        signal: controller.signal,
      });

      if (!res.body) throw new Error("No response stream from server");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        replyText += chunk;
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = {
            role: "assistant",
            content: next[next.length - 1].content + chunk,
          };
          return next;
        });
      }

      speak(replyText);
    } catch (err) {
      // Deliberate interrupt, not a real failure -- interruptWithFollowUp
      // already tore down this turn's messages and started the next one;
      // showing a "connection trouble" bubble here would stomp on it.
      if (err instanceof Error && err.name === "AbortError") return;
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "assistant",
          content: `[Connection trouble, sir: ${err instanceof Error ? err.message : String(err)}]`,
        };
        return next;
      });
    } finally {
      if (activeRequestIdRef.current === requestId) {
        setSending(false);
      }
      refreshActivity(); // any tool calls made during this reply show up now
    }
  }

  // Cancels whatever's currently in flight and immediately starts a fresh
  // request that folds the interrupting follow-up in with the original,
  // unanswered message -- per the user's explicit choice of "interrupt and
  // restart" over "queue for after".
  function interruptWithFollowUp(followUpText: string) {
    const original = pendingOriginalTextRef.current;
    abortControllerRef.current?.abort();
    setMessages((prev) => prev.slice(0, -2)); // drop the abandoned user+assistant pair
    sendingRef.current = false;
    setSending(false);
    const combined = original
      ? `${original}\n\n(I'm adding this before you could respond: ${followUpText})`
      : followUpText;
    sendMessage(combined);
  }

  function startListening() {
    if (listeningRef.current) return;
    // Captured once, at the moment listening starts -- not re-read later,
    // since sendingRef.current can legitimately flip (e.g. the original
    // reply finishes naturally while the user is still talking) before the
    // final transcript arrives. What matters is what was true when the user
    // chose to interrupt, not the state several seconds later.
    const wasInterrupting = sendingRef.current;
    stopWakeListener();

    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) return;

    let gotFinal = false;
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "en-GB";
    // continuous, not one-shot: with continuous:false, Chrome can end the
    // whole session on a brief mid-thought pause ("um... actually...")
    // before a final result ever comes through, which reads as Pat
    // abandoning the conversation. Final-result detection below already
    // calls recognition.stop() itself the moment a complete utterance
    // arrives, so this only buys patience for pauses, not extra listening
    // after you're done talking.
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setInput(transcript);

      const lastResult = event.results[event.results.length - 1];
      if (lastResult?.isFinal) {
        gotFinal = true;
        recognition.stop();
        const echo = looksLikeSelfEcho(transcript, lastSpokenRef.current);
        lastSpokenRef.current = "";
        if (echo) {
          setInput("");
          return;
        }
        if (wasInterrupting) {
          interruptWithFollowUp(transcript);
        } else {
          sendMessage(transcript);
        }
      }
    };
    recognition.onerror = () => {
      setListening(false);
      stopMicMeter();
    };
    recognition.onend = () => {
      setListening(false);
      stopMicMeter();
      // Nobody said anything before the recognizer timed out. If this was a
      // hands-free follow-up listen, drop back to passive wake-word
      // listening instead of leaving the overlay open with nothing
      // happening. If it was an interrupt attempt, the original request was
      // never touched (only a successful transcript aborts it) -- just let
      // it keep processing/speaking as if the mic click never happened.
      if (!gotFinal && !wasInterrupting && voiceModeRef.current) {
        setVoiceOverlayOpen(false);
        startWakeListener();
      }
    };

    recognitionRef.current = recognition;
    setListening(true);
    setVoiceOverlayOpen(true);
    try {
      recognition.start();
    } catch {
      // Browsers can throw (e.g. InvalidStateError) if a recognition session
      // is started too soon after another one just ended. Previously this
      // just closed the overlay and stopped -- a dead end with no active
      // AND no passive listening running, which looks exactly like Pat
      // silently abandoning the conversation. Fall back to the passive
      // wake listener instead, same as the no-speech-timeout path below.
      setListening(false);
      setVoiceOverlayOpen(false);
      if (!wasInterrupting && voiceModeRef.current) {
        startWakeListener();
      }
    }
    startMicMeter();
  }

  function toggleListening() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

    stopSpeaking();
    startListening();
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerBrand}>
          <strong>Pat</strong>
          <span>
            <span className={styles.slash}>{"//"}</span> 01
          </span>
        </div>
        <div className={styles.headerTags}>
          {voiceMode ? "voice" : "text"} · streaming · tool-use
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <span className={styles.avatar} aria-hidden="true">P</span>
          <div className={styles.sidebarName}>Pat</div>
          <p className={styles.tagline}>Elite executive assistant. Dry wit, zero hesitation.</p>

          <div className={styles.sidebarLabel}>Mode</div>
          <div className={styles.modePills}>
            <button
              type="button"
              className={`${styles.modePill} ${!voiceMode ? styles.modePillActive : ""}`}
              onClick={closeVoiceOverlay}
            >
              Text
            </button>
            {voiceSupported && (
              <button
                type="button"
                className={`${styles.modePill} ${voiceMode ? styles.modePillActive : ""}`}
                onClick={() => {
                  voiceModeRef.current = true;
                  setVoiceMode(true);
                  startWakeListener();
                }}
              >
                Voice
              </button>
            )}
          </div>

          {voiceMode && !voiceOverlayOpen && <p className={styles.wakeHint}>Say &ldquo;hello Pat&rdquo; to start</p>}

          <div className={styles.sidebarMeta}>
            <span>Model · Claude Sonnet 5</span>
            <span>Session · Local-first</span>
            <button type="button" className={styles.memoryTrigger} onClick={() => setMemoryPanelOpen(true)}>
              Memory · {memoryCount === null ? "…" : `${memoryCount} fact${memoryCount === 1 ? "" : "s"}`}
            </button>
          </div>
        </aside>

        <main className={styles.main}>
          <div className={styles.transcript}>
            {messages.map((m, i) => (
              <div key={i} className={`${styles.msgRow} ${m.role === "user" ? styles.msgRowUser : styles.msgRowAssistant}`}>
                <div className={`${styles.bubble} ${m.role === "user" ? styles.bubbleUser : styles.bubbleAssistant}`}>
                  <span className={styles.bubbleText}>
                    {m.content ||
                      (sending && i === messages.length - 1 ? (
                        <span className={styles.thinking}>considering, sir…</span>
                      ) : (
                        ""
                      ))}
                  </span>
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <form
            className={styles.inputBar}
            onSubmit={(e) => {
              e.preventDefault();
              const text = input.trim();
              if (!text) return;
              if (sendingRef.current) {
                interruptWithFollowUp(text);
              } else {
                sendMessage(text);
              }
            }}
          >
            {voiceSupported && (
              <button
                type="button"
                className={`${styles.mic} ${listening ? styles.micActive : ""}`}
                aria-pressed={listening}
                aria-label={listening ? "Stop listening" : sending ? "Interrupt with a follow-up" : "Speak to Pat"}
                onClick={toggleListening}
              >
                <MicIcon />
              </button>
            )}
            <input
              className={styles.textInput}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                listening ? "Listening, sir…" : sending ? "Add something before I finish…" : "Speak or write to Pat…"
              }
            />
            {speaking ? (
              <button type="button" className={styles.stop} onClick={handleStopButton}>
                Stop
              </button>
            ) : (
              <button type="submit" className={styles.send} disabled={!input.trim()} aria-label="Send">
                <ArrowIcon />
              </button>
            )}
          </form>
        </main>

        <aside className={styles.ledger}>
          <h2>Activity log</h2>
          {activity.length === 0 && <p className={styles.ledgerEmpty}>The ledger is empty, sir.</p>}
          <ul>
            {activity.map((a) => (
              <li key={a.id} className={styles.ledgerRow}>
                <span className={`${styles.ledgerDot} ${a.status === "error" ? styles.dotError : styles.dotOk}`} />
                <div className={styles.ledgerBody}>
                  <div className={styles.ledgerHead}>
                    <span className={styles.ledgerName}>{a.tool_name}</span>
                    <span className={styles.ledgerStatus}>{a.status}</span>
                  </div>
                  <time>{a.created_at}</time>
                </div>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      {voiceOverlayOpen && (
        <div className={styles.voiceOverlay} role="dialog" aria-modal="true" aria-label="Voice conversation with Pat">
          <button
            type="button"
            className={styles.voiceOverlayClose}
            aria-label="Close voice conversation"
            onClick={closeVoiceOverlay}
          >
            <CloseIcon />
          </button>

          <div className={`${styles.stage} ${ORB_STATE_CLASS[orbState]}`}>
            <span className={`${styles.stateLabel} ${orbState !== "standby" ? styles.stateLabelActive : ""}`}>
              {ORB_STATE_LABEL[orbState]}
            </span>
            <div className={styles.orbWrap}>
              <span className={styles.ping} />
              <span className={styles.ping} />
              <span className={styles.spinner} />
              <span ref={orbRef} className={styles.orb} />
            </div>
          </div>

          <p className={styles.overlayCaption}>
            {listening
              ? input || "Listening, sir…"
              : speaking
                ? messages[messages.length - 1]?.content ?? ""
                : sending
                  ? "Tap the bell to add something before I finish"
                  : ""}
          </p>

          <div className={styles.overlayControls}>
            {voiceSupported && (
              <button
                type="button"
                className={`${styles.mic} ${listening ? styles.micActive : ""}`}
                aria-pressed={listening}
                aria-label={listening ? "Stop listening" : sending ? "Interrupt with a follow-up" : "Speak to Pat"}
                onClick={toggleListening}
              >
                <MicIcon />
              </button>
            )}
            {speaking && (
              <button type="button" className={styles.stop} onClick={handleStopButton}>
                Stop
              </button>
            )}
          </div>
        </div>
      )}

      {memoryPanelOpen && (
        <div
          className={styles.memoryPanel}
          role="dialog"
          aria-modal="true"
          aria-label="Manage Pat's memory"
          onClick={(e) => {
            if (e.target === e.currentTarget) setMemoryPanelOpen(false);
          }}
        >
          <div className={styles.memoryPanelInner}>
            <div className={styles.memoryPanelHead}>
              <h2>Memory</h2>
              <button
                type="button"
                className={styles.memoryPanelClose}
                aria-label="Close memory panel"
                onClick={() => setMemoryPanelOpen(false)}
              >
                <CloseIcon />
              </button>
            </div>
            {memories.length === 0 ? (
              <p className={styles.ledgerEmpty}>Nothing remembered yet, sir.</p>
            ) : (
              <ul className={styles.memoryList}>
                {memories.map((m) => (
                  <li key={m.id} className={styles.memoryItem}>
                    <span className={styles.memoryItemText}>{m.content}</span>
                    <button
                      type="button"
                      className={styles.memoryItemDelete}
                      aria-label={`Forget: ${m.content}`}
                      onClick={() => deleteMemory(m.id)}
                    >
                      <CloseIcon />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
