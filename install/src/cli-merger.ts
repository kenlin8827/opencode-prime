import fs from "node:fs";
import path from "node:path";
import { readJsoncFile } from "./merger";

/**
 * cli.json merge pipeline (V2 terminal-client config) — extracted from
 * merger.ts, which owns the opencode.jsonc side. One module per config
 * surface: this file covers plugins union, per-leaf defaults fill, and the
 * v1 tui.json(c) upgrade seam for the ONE global ~/.config/opencode/cli.json.
 */

/**
 * Recursively fills the MISSING leaves of `user` from `defaults`
 * (template-as-defaults, existing-wins at leaf granularity).
 *
 *   - both plain objects → recurse key by key (a user's `session` block no
 *     longer blocks new template defaults inside `session` from propagating)
 *   - user leaf defined (INCLUDING explicit false/null) → user wins, never
 *     overwritten
 *   - arrays are user state wholesale (no element-wise merging; `plugins`
 *     is handled separately by package-key union upstream)
 *
 * Known trade-off (documented in mergeTuiConfig): a leaf the user
 * deliberately DELETED is re-seeded from the template on the next install —
 * acceptable for cli.json (TUI prefs, template churn is rare); if it ever
 * bites, mirror the providers ledger (.ocp/providers.seeded.txt).
 */
function fillMissingLeaves(defaults: any, user: any): any {
  const isPlainObject = (v: unknown): v is Record<string, any> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (user === undefined) return defaults;
  if (!isPlainObject(defaults) || !isPlainObject(user)) return user;
  const out: Record<string, any> = { ...user };
  for (const [k, v] of Object.entries(defaults)) {
    out[k] = fillMissingLeaves(v, user[k]);
  }
  return out;
}

/** Package key of a cli.json plugin entry: string entry = itself, object
 *  entry = .package; null marks malformed entries (dropped, never thrown). */
function cliPluginKey(p: unknown): string | null {
  if (typeof p === "string") return p;
  return p && typeof p === "object" && typeof (p as any).package === "string"
    ? (p as any).package
    : null;
}

/**
 * Plugin-list merge for cli.json: union of template + existing, deduped by
 * package key, template-first so OCP plugins keep their canonical order.
 * Retired factory plugins (template `removed_plugins`, mirroring
 * opencode.template.jsonc's `removed_agents`) are stripped from the union —
 * without the list a removed factory plugin survives in cli.json forever
 * (the union cannot distinguish "user-added" from "factory, later deleted")
 * while the stale-file prune has already deleted its files.
 */
function mergeCliPlugins(template: Record<string, any>, existing: Record<string, any>): unknown[] {
  const removedPlugins = new Set(
    Array.isArray(template.removed_plugins)
      ? template.removed_plugins.filter((n: unknown) => typeof n === "string")
      : [],
  );
  const valid = (list: unknown): unknown[] =>
    (Array.isArray(list) ? list : []).filter((p: unknown) => cliPluginKey(p) !== null);
  const templatePlugins = valid(template.plugins);
  const existingPlugins = valid(existing.plugins);
  const seen = new Set(templatePlugins.map(cliPluginKey));
  return [
    ...templatePlugins,
    ...existingPlugins.filter((p: unknown) => !seen.has(cliPluginKey(p))),
  ].filter((p: unknown) => !removedPlugins.has(cliPluginKey(p) ?? ""));
}

/**
 * V1 → V2 upgrade seam: when no cli.json exists but a legacy tui.json(c)
 * does, return its content pre-shaped as v2 `existing` state (plugin list
 * migrated — string kept, tuple [path, options] → {package, options};
 * `display_thinking` → `session.thinking`) — same mapping opencode's own
 * ConfigMigration performs, applied here so the OCP-managed plugin union
 * survives the jump. Returns null when there is nothing to migrate.
 */
function readLegacyTuiAsExisting(targetDir: string): Record<string, any> | null {
  const legacyTui =
    readJsoncFile<Record<string, any>>(path.join(targetDir, "tui.jsonc")) ??
    readJsoncFile<Record<string, any>>(path.join(targetDir, "tui.json"));
  if (!legacyTui || typeof legacyTui !== "object" || Array.isArray(legacyTui)) return null;
  const existing: Record<string, any> = { ...legacyTui };
  delete existing.$schema;
  delete existing.theme; // v1 scalar → v2 theme.name below
  const plugins = (Array.isArray(legacyTui.plugin) ? legacyTui.plugin : []).map(
    (p: unknown) =>
      Array.isArray(p) && typeof p[0] === "string" ? { package: p[0], options: p[1] } : p,
  );
  if (plugins.length) existing.plugins = plugins;
  delete existing.plugin;
  if (typeof legacyTui.display_thinking === "boolean") {
    existing.session = {
      ...(existing.session ?? {}),
      thinking: legacyTui.display_thinking ? "show" : "hide",
    };
    delete existing.display_thinking;
  }
  if (typeof legacyTui.theme === "string") {
    existing.theme = { ...(existing.theme ?? {}), name: legacyTui.theme };
  }
  return existing;
}

/**
 * V2 terminal-client merge: repo's cli.template.jsonc with the target's
 * global cli.json, written back to <target>/cli.json. V2 replaced the layered
 * v1 tui.json(c) with ONE global cli file (~/.config/opencode/cli.json) —
 * read by the TUI only, never the server (v2src packages/cli/src/config/
 * config.ts).
 *
 * Orchestrates the three merge concerns (each its own function above):
 *   - plugins[]   → mergeCliPlugins (package-key union + removed_plugins)
 *   - other keys  → fillMissingLeaves (existing wins per leaf, missing
 *     leaves seeded from the template)
 *   - v1 upgrade  → readLegacyTuiAsExisting (only when no cli.json exists)
 * `$schema` always comes from the template (it's a pointer, not user state);
 * `removed_plugins` is installer-only metadata, stripped from the output.
 *
 * First install (no existing target): writes the template directly.
 */
export function mergeTuiConfig(repoDir: string, targetDir: string): void {
  const templatePath = path.join(repoDir, "cli.template.jsonc");
  const targetPath = path.join(targetDir, "cli.json");

  const template = readJsoncFile<Record<string, any>>(templatePath);
  if (!template || Object.keys(template).length === 0) {
    // No template — nothing to seed; leave target alone (or absent).
    return;
  }

  let existing: Record<string, any> = {};
  if (fs.existsSync(targetPath)) {
    // cli.json is external, user-editable input: a scalar or array parse
    // result is garbage, not state — treating it as {} re-seeds the file
    // instead of crashing the merge or writing a corrupt config back.
    const parsed = readJsoncFile<Record<string, any>>(targetPath);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed;
    }
  }

  if (Object.keys(existing).length === 0) {
    existing = readLegacyTuiAsExisting(targetDir) ?? existing;
  }

  const merged: Record<string, any> = fillMissingLeaves(template, existing);
  merged.plugins = mergeCliPlugins(template, existing);
  delete merged.removed_plugins;
  delete merged.$schema;
  merged.$schema = template.$schema;

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
}
