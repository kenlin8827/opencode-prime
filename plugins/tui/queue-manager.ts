/// <reference types="bun" />
import type { Context } from "@opencode/plugin/tui/context"
import { Plugin } from "@opencode/plugin/tui"
import type { SessionInboxInfo, SessionInboxUser } from "@opencode/client"
import { tr, initI18n, languageOption, switchLanguage, SWITCH_LANG } from "./i18n"

/**
 * Queue Manager — TUI dialog-based management of queued user prompts.
 *
 * v2 model: prompts admitted while the session is busy live in the
 * session INBOX (`session_inbox` rows, surfaced via
 * `ctx.data.session.pending` and the `client.session.inbox` API) until a
 * safe boundary delivers them. This plugin gives that pile a management
 * UI: list, inspect, toggle delivery mode (steer/queue), cancel one, or
 * cancel all.
 *
 * Registered as a CLI-only plugin in `cli.json` (v2 TUI plugin list).
 *
 * Entry points:
 *   /queued                — slash command (opens the manager)
 *   command palette        — "Manage queued messages"
 *
 * Operations and their server-side mechanics (v2):
 *   - Cancel → DELETE /api/session/:id/inbox/:inboxID. Inbox rows are
 *     unconsumed work; cancellation is a first-class operation with no
 *     busy-assert, so v1's 409 "strip the message" fallback dance with
 *     updatePart/deletePart is gone.
 *   - Delivery toggle → PATCH /api/session/:id/inbox/:inboxID
 *     { delivery: "steer" | "queue" } — steering promotes the item ahead
 *     of queued work at the next safe boundary.
 *   - View → non-dismissable text dialog, Esc returns.
 *
 * OCP-V2-GAP: v1's "Edit text" is dropped. The v2 inbox API can cancel,
 * re-admit, and change delivery, but NOT rewrite a pending item's
 * payload; "cancel + re-prompt" would silently reorder the queue, which
 * is worse UX than offering no edit at all.
 */

const PLUGIN_ID = "opencode-prime.queue-manager"
const SLASH_NAME = "queued"
const PREVIEW_MAX = 90

// ─── Types ───────────────────────────────────────────────────────────

export interface QueuedEntry {
  inboxID: string
  created: number
  preview: string
  text: string
  delivery: "steer" | "queue"
  /** Attached files (images/documents) on the prompt payload. */
  attachments: number
}

// ─── Pure helpers (unit-testable) ────────────────────────────────────

/** Single-line truncated preview for dialog options. */
export function preview(text: string, max = PREVIEW_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (!flat) return tr("queue.attachmentOnly")
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat
}

/**
 * The queue: pending user inbox items, in admission order. Synthetic /
 * compaction / move items are internal work, never user-visible queue
 * entries, and are filtered out.
 */
export function computeQueued(items: SessionInboxInfo[]): QueuedEntry[] {
  return items
    .filter((item): item is SessionInboxUser => item.type === "user")
    .map((item) => ({
      inboxID: item.id,
      created: item.time.created,
      preview: preview(item.payload.text),
      text: item.payload.text,
      delivery: item.delivery,
      attachments: item.payload.files?.length ?? 0,
    }))
    .sort((a, b) => a.created - b.created)
}

/** Human-friendly age for dialog descriptions. */
export function age(created: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - created) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return `${h}h ago`
}

// ─── Context plumbing ────────────────────────────────────────────────

function toast(ctx: Context, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  ctx.ui.toast.show({ title: tr("queue.toastTitle"), message, variant })
}

function isRunning(ctx: Context, sessionID: string): boolean {
  return ctx.data.session.status(sessionID) === "running"
}

async function fetchPending(ctx: Context, sessionID: string): Promise<SessionInboxInfo[] | undefined> {
  try {
    await ctx.data.session.pending.sync(sessionID)
    return ctx.data.session.pending.list(sessionID)
  } catch (err) {
    toast(ctx, tr("queue.loadMessagesError", { err: (err as Error).message }), "error")
    return undefined
  }
}

// ─── Actions ─────────────────────────────────────────────────────────

async function cancelEntry(ctx: Context, sessionID: string, entry: QueuedEntry): Promise<boolean> {
  try {
    await ctx.client.session.inbox.cancel({ sessionID, inboxID: entry.inboxID })
    ctx.data.session.pending.invalidate(sessionID)
    return true
  } catch (err) {
    toast(ctx, tr("queue.deleteFailed", { err: (err as Error).message }), "error")
    return false
  }
}

async function toggleDelivery(ctx: Context, sessionID: string, entry: QueuedEntry): Promise<boolean> {
  const next = entry.delivery === "queue" ? "steer" : "queue"
  try {
    await ctx.client.session.inbox.update({ sessionID, inboxID: entry.inboxID, delivery: next })
    ctx.data.session.pending.invalidate(sessionID)
    toast(ctx, tr("queue.deliveryChanged", { id: entry.inboxID.slice(0, 8), delivery: next }), "success")
    return true
  } catch (err) {
    toast(ctx, tr("queue.deliveryFailed", { err: (err as Error).message }), "error")
    return false
  }
}

// ─── Dialog flow ─────────────────────────────────────────────────────

/**
 * Entry menu for one queued item. Returns the next action for the list
 * loop: "back" re-presents the list, "exit" closes the manager.
 */
async function openEntryMenu(
  ctx: Context,
  sessionID: string,
  entry: QueuedEntry,
): Promise<"back" | "exit"> {
  for (;;) {
    const pick = await ctx.ui.dialog.select<string>({
      title: tr("queue.entryTitle", { age: age(entry.created) }),
      placeholder: entry.preview,
      options: [
        {
          title: tr("queue.viewAction"),
          value: "view",
          description: tr("queue.viewActionDesc"),
        },
        {
          title: entry.delivery === "queue" ? tr("queue.steerAction") : tr("queue.enqueueAction"),
          value: "delivery",
          description: entry.delivery === "queue"
            ? tr("queue.steerActionDesc")
            : tr("queue.enqueueActionDesc"),
        },
        {
          title: tr("queue.cancelAction"),
          value: "cancel",
          description: isRunning(ctx, sessionID)
            ? tr("queue.sessionBusy")
            : tr("queue.sessionIdle"),
        },
        {
          title: tr("queue.backToQueue"),
          value: "back",
        },
      ],
    })
    if (pick === undefined || pick === "back") return "back"
    if (pick === "view") {
      await ctx.ui.dialog.alert({
        title: tr("queue.fullTextTitle"),
        message: entry.text || tr("queue.noTextAttachmentsOnly"),
      })
      continue
    }
    if (pick === "delivery") {
      if (await toggleDelivery(ctx, sessionID, entry)) return "back"
      continue
    }
    if (pick === "cancel") {
      const busy = isRunning(ctx, sessionID)
      const confirmed = await ctx.ui.dialog.confirm({
        title: tr("queue.cancelTitle"),
        message: busy
          ? tr("queue.confirmCancelBusy", { preview: entry.preview })
          : tr("queue.confirmCancelIdle", { preview: entry.preview }),
      })
      if (confirmed === true) {
        await cancelEntry(ctx, sessionID, entry)
        return "back"
      }
      continue
    }
  }
}

async function openQueueList(ctx: Context, sessionID: string): Promise<void> {
  const items = await fetchPending(ctx, sessionID)
  if (!items) {
    ctx.ui.dialog.clear()
    return
  }

  const entries = computeQueued(items)
  if (entries.length === 0) {
    ctx.ui.dialog.clear()
    toast(ctx, tr("queue.noQueuedMessages"), "info")
    return
  }

  const busy = isRunning(ctx, sessionID)
  for (;;) {
    const pick = await ctx.ui.dialog.select<string>({
      title: tr("queue.listTitle", { count: entries.length, busy: busy ? tr("queue.sessionBusy") : tr("queue.sessionIdle") }),
      placeholder: tr("queue.listPlaceholder"),
      // `category` renders as bold accent section headers that are not
      // focusable options — real grouping, no fake rows.
      options: [
        ...entries.map((entry, i) => ({
          title: `#${i + 1} ${entry.preview}`,
          value: entry.inboxID,
          description: `${age(entry.created)} · ${entry.delivery === "steer" ? tr("queue.deliverySteer") : tr("queue.deliveryQueue")}${
            entry.attachments ? ` · ${tr("queue.attachmentCount", { count: entry.attachments })}` : ""
          }`,
          category: tr("queue.queuedHeader"),
        })),
        ...(entries.length > 1
          ? [
              {
                title: tr("queue.cancelAll"),
                value: "__cancel_all__",
                description: tr("queue.stripAllCount", { count: entries.length }),
                category: tr("queue.actionsHeader"),
              },
            ]
          : []),
        { ...languageOption(), category: tr("common.interfaceHeader") },
      ],
    })
    // Esc on queue list = close
    if (pick === undefined) return
    if (pick === SWITCH_LANG) {
      await switchLanguage(ctx)
      continue
    }
    if (pick === "__cancel_all__") {
      await confirmCancelAll(ctx, sessionID, entries)
      return
    }
    const entry = entries.find((e) => e.inboxID === pick)
    if (!entry) continue
    const next = await openEntryMenu(ctx, sessionID, entry)
    if (next === "exit") return
    // "back" — re-read the (possibly changed) pending list.
    const refreshed = await fetchPending(ctx, sessionID)
    if (!refreshed) return
    entries.length = 0
    entries.push(...computeQueued(refreshed))
    if (entries.length === 0) {
      toast(ctx, tr("queue.noQueuedMessages"), "info")
      return
    }
  }
}

async function confirmCancelAll(ctx: Context, sessionID: string, entries: QueuedEntry[]): Promise<void> {
  const busy = isRunning(ctx, sessionID)
  const confirmed = await ctx.ui.dialog.confirm({
    title: tr("queue.cancelAllTitle"),
    message: busy
      ? tr("queue.confirmCancelAllBusy", { count: entries.length })
      : tr("queue.confirmCancelAllIdle", { count: entries.length }),
  })
  if (confirmed !== true) return
  let ok = 0
  for (const entry of entries) {
    if (await cancelEntry(ctx, sessionID, entry)) ok++
  }
  toast(ctx, tr("queue.cancelResult", { ok, total: entries.length }), ok === entries.length ? "success" : "warning")
}

// ─── Plugin entry ────────────────────────────────────────────────────

export default Plugin.define({
  id: PLUGIN_ID,
  setup(ctx: Context) {
    initI18n()
    ctx.keymap.layer(() => ({
      commands: [
        {
          id: "queue.manager",
          title: tr("queue.cmdTitle"),
          description: tr("queue.cmdDesc"),
          group: "Session",
          palette: true,
          slash: { name: SLASH_NAME },
          run() {
            const route = ctx.ui.router.current()
            if (route.type !== "session") {
              toast(ctx, tr("queue.openSessionFirst"), "warning")
              return
            }
            void openQueueList(ctx, route.sessionID)
          },
        },
      ],
    }))
  },
})
