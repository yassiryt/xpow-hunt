/**
 * Auto-Continue Watchdog
 * ----------------------
 * pi runs one agentic turn per user message and idles when the model returns a
 * turn with no tool call (text-only, empty, or an errored/degraded completion).
 * During a long autonomous hunt that "stops until you prompt it" — which is the
 * stall we root-caused (an empty completion after a parallel tool batch).
 *
 * This watchdog, when a hunt is active (PI_AUTOCONTINUE=1, set by `xpow-hunt`) and
 * only in interactive TUI mode, auto-sends a "continue" message on turn_end so
 * the coordinator keeps going by itself — with hard safeguards so it can never
 * loop forever or fight the user.
 *
 * Activates ONLY when:  PI_AUTOCONTINUE=1  AND  ctx.mode === "tui"
 *   => never runs in plain coding sessions, never in subagents (json/print mode).
 *
 * Stops / does NOT continue when:
 *   - the model explicitly ends with [[HUNT_COMPLETE]] or [[HUNT_BLOCKED: ...]]
 *   - the user aborted the turn (stopReason "aborted")  -> hands control back
 *   - the user has queued/typed a message, or the agent isn't idle
 *   - too many consecutive no-progress (no-tool) turns  (PI_AUTOCONTINUE_MAX_EMPTY, default 3)
 *   - a per-session lifetime cap is hit                 (PI_AUTOCONTINUE_MAX, default 400)
 *   - toggled off with /autocontinue off
 *
 * Tunables (env): PI_AUTOCONTINUE_MAX_EMPTY, PI_AUTOCONTINUE_MAX,
 *                 PI_AUTOCONTINUE_DELAY_MS (default 1500; errored turns wait >=5s).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const enabled = () => process.env.PI_AUTOCONTINUE === "1";
const MAX_EMPTY = Math.max(1, parseInt(process.env.PI_AUTOCONTINUE_MAX_EMPTY || "3", 10) || 3);
const MAX_TOTAL = Math.max(1, parseInt(process.env.PI_AUTOCONTINUE_MAX || "400", 10) || 400);
const DELAY_MS = Math.max(0, parseInt(process.env.PI_AUTOCONTINUE_DELAY_MS || "1500", 10) || 1500);

// Distinctive end-of-hunt markers the coordinator is told to emit (prompt hardening).
const COMPLETE_RE = /\[\[\s*HUNT[ _]?COMPLETE\s*\]\]/i;
const BLOCKED_RE = /\[\[\s*HUNT[ _]?BLOCKED/i;

const CONTINUE_MSG =
  "Auto-continue (watchdog): keep going autonomously — do NOT stop or wait for me. " +
  "Take the next concrete action right now with a tool call; if you have nothing to say, act, don't narrate. " +
  "Only stop by ending your message with exactly [[HUNT_COMPLETE]] when the hunt is genuinely finished/exhausted, " +
  "or [[HUNT_BLOCKED: <one-line reason>]] if you truly need my input.";

function lastText(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b: any) => b && b.type === "text").map((b: any) => b.text || "").join("\n");
  return "";
}

export default function autoContinueWatchdog(pi: ExtensionAPI) {
  let emptyStreak = 0; // consecutive no-progress (no-tool) turns
  let total = 0; // lifetime auto-continues this session
  let pausedByUser = false; // /autocontinue off
  let pausedBySafety = false; // hit a cap
  let scheduled = false; // a continue is already scheduled for this idle

  pi.registerCommand("autocontinue", {
    description: "Auto-continue watchdog: on | off | status",
    handler: async (args, ctx) => {
      const a = (args || "").trim().toLowerCase();
      if (a === "off") {
        pausedByUser = true;
        ctx.ui.notify("auto-continue: OFF (you paused it)", "info");
      } else if (a === "on") {
        pausedByUser = false;
        pausedBySafety = false;
        emptyStreak = 0;
        ctx.ui.notify("auto-continue: ON", "info");
      } else {
        const on = enabled() && !pausedByUser && !pausedBySafety;
        ctx.ui.notify(
          `auto-continue: ${on ? "ON" : "OFF"} (env=${enabled() ? "1" : "0"}, mode-gated to tui) | emptyStreak=${emptyStreak}/${MAX_EMPTY} total=${total}/${MAX_TOTAL}`,
          "info",
        );
      }
    },
  });

  pi.on("turn_end", async (event, ctx) => {
    try {
      if (!enabled() || pausedByUser || pausedBySafety) return;
      if (ctx.mode !== "tui") return; // never in headless/subagent (json/print) or rpc

      const msg: any = (event as any)?.message;
      const stop = msg?.stopReason;

      // User explicitly interrupted -> hand control back, reset.
      if (stop === "aborted") {
        emptyStreak = 0;
        return;
      }

      // Explicit stop signal from the model -> respect it, do not continue.
      const text = lastText(msg);
      if (COMPLETE_RE.test(text) || BLOCKED_RE.test(text)) {
        ctx.ui.notify("auto-continue: hunt complete/blocked marker seen — standing by.", "info");
        emptyStreak = 0;
        return;
      }

      // Progress = the turn produced tool results. No tools = a stall/idle turn.
      const toolResults = (event as any)?.toolResults;
      const madeProgress = Array.isArray(toolResults) && toolResults.length > 0;
      if (madeProgress) emptyStreak = 0;
      else emptyStreak += 1;

      // Safety: stop nudging if the agent is stuck producing nothing.
      if (emptyStreak > MAX_EMPTY) {
        pausedBySafety = true;
        ctx.ui.notify(
          `auto-continue: paused after ${emptyStreak} no-progress turns (agent may be stuck or asking). Resume with /autocontinue on.`,
          "warning",
        );
        return;
      }
      if (total >= MAX_TOTAL) {
        pausedBySafety = true;
        ctx.ui.notify(`auto-continue: lifetime cap ${MAX_TOTAL} reached — paused. Resume with /autocontinue on.`, "warning");
        return;
      }

      if (scheduled) return;
      scheduled = true;
      // Errored turns (e.g. 429-exhausted) wait longer to let rate limits cool.
      const delay = stop === "error" ? Math.max(DELAY_MS, 5000) : DELAY_MS;
      setTimeout(async () => {
        scheduled = false;
        try {
          if (!enabled() || pausedByUser || pausedBySafety) return;
          // Only inject if still idle and the user hasn't queued/typed anything.
          if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
          total += 1;
          await pi.sendUserMessage(CONTINUE_MSG);
        } catch {
          /* never crash the session */
        }
      }, delay).unref?.();
    } catch {
      /* never crash the session */
    }
  });
}
