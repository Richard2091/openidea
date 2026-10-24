/**
 * Search Everywhere result model: item types, per-section merging/ranking
 * and the flat row list (section headers + "more" rows) the dialog renders.
 */
import type { Action } from "@/platform/actions";
import type { FileMatch, LineMatch, SymbolMatch, WorkspaceSymbol } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { basename, isTypeKind, relDir, symbolDisplayName } from "../common/open";
import { byScore, matchText } from "../common/rank";

export type SeTab = "all" | "classes" | "files" | "symbols" | "actions" | "text";
export type SectionId = "recent" | "recentActions" | "classes" | "files" | "symbols" | "actions" | "text";

export const TABS: ReadonlyArray<{ id: SeTab; label: string }> = [
  { id: "all", label: "All" },
  { id: "classes", label: "Classes" },
  { id: "files", label: "Files" },
  { id: "symbols", label: "Symbols" },
  { id: "actions", label: "Actions" },
  { id: "text", label: "Text" },
];

export const SECTION_ORDER: readonly SectionId[] = [
  "recent",
  "recentActions",
  "classes",
  "files",
  "symbols",
  "actions",
  "text",
];

export const SECTION_TITLES: Record<SectionId, string> = {
  recent: "Recent Files",
  recentActions: "Recent Actions",
  classes: "Classes",
  files: "Files",
  symbols: "Symbols",
  actions: "Actions",
  text: "Text",
};

/** Sections a tab queries, for a non-empty and an empty query. */
export function sectionsFor(tab: SeTab, emptyQuery: boolean): SectionId[] {
  if (emptyQuery) {
    switch (tab) {
      case "all":
        return ["recent", "recentActions"];
      case "files":
        return ["recent"];
      case "actions":
        return ["recentActions"];
      default:
        return [];
    }
  }
  return tab === "all" ? ["classes", "files", "symbols", "actions", "text"] : [tab];
}

export const ALL_TAB_LIMIT = 6;
export const TAB_LIMIT = 50;
export const MORE_STEP_ALL = 15;
export const MORE_STEP_TAB = 50;
export const RECENT_LIMIT = 15;

export interface FileItem {
  kind: "file";
  key: string;
  path: string;
  rel: string;
  name: string;
  dir: string;
  nameIndices: number[];
  line: number | null;
  col: number | null;
}

export interface SymbolItem {
  kind: "symbol";
  key: string;
  name: string;
  display: string;
  symbolKind: string;
  container: string | null;
  path: string;
  rel: string;
  line: number;
  col: number;
  indices: number[];
  /** From the language server rather than the index. */
  lsp?: boolean;
}

export interface ActionItem {
  kind: "action";
  key: string;
  id: string;
  title: string;
  category?: string;
  icon?: string;
  enabled: boolean;
  indices: number[];
  score: number;
}

export interface TextItem {
  kind: "text";
  key: string;
  path: string;
  rel: string;
  line: number;
  col: number;
  endCol: number;
  /** Preview with leading whitespace removed. */
  text: string;
  indices: number[];
}

export type SeItem = FileItem | SymbolItem | ActionItem | TextItem;

export type SeRow =
  | { kind: "section"; key: string; section: SectionId; title: string }
  | { kind: "more"; key: string; section: SectionId }
  | (SeItem & { section: SectionId });

export interface SectionState {
  items: SeItem[];
  hasMore: boolean;
  loading: boolean;
}

// ---------------------------------------------------------------------------
// Item builders

export function fileItem(
  m: Pick<FileMatch, "path" | "relPath" | "indices">,
  line: number | null = null,
  col: number | null = null,
): FileItem {
  const name = basename(m.relPath);
  const nameStart = m.relPath.length - name.length;
  return {
    kind: "file",
    key: `f:${m.path}`,
    path: m.path,
    rel: m.relPath,
    name,
    dir: relDir(m.relPath),
    nameIndices: m.indices.filter((i) => i >= nameStart).map((i) => i - nameStart),
    line,
    col,
  };
}

export function symbolItem(m: SymbolMatch): SymbolItem {
  return {
    kind: "symbol",
    key: `s:${m.path}:${m.range.start.line}:${m.range.start.col}:${m.name}`,
    name: m.name,
    display: symbolDisplayName(m.name, m.kind),
    symbolKind: m.kind,
    container: m.container,
    path: m.path,
    rel: m.relPath,
    line: m.range.start.line,
    col: m.range.start.col,
    indices: m.indices,
  };
}

const isExact = (name: string, query: string) => name.toLowerCase() === query.trim().toLowerCase();

const dedupeKey = (path: string, line: number, name: string) => `${path}\u0000${line}\u0000${name}`;

/**
 * Index results keep the backend's order; language-server symbols that the
 * index doesn't know are scored locally and appended (or interleaved when they
 * clearly match better, e.g. an exact name hit).
 */
export function mergeSymbols(
  index: readonly SymbolMatch[],
  lsp: readonly WorkspaceSymbol[],
  query: string,
  opts: { root: string | null; includeNonProject: boolean; typesOnly: boolean; excludeTypes: boolean; limit: number },
): { items: SymbolItem[]; hasMore: boolean } {
  const keep = (kind: string) => (opts.typesOnly ? isTypeKind(kind) : opts.excludeTypes ? !isTypeKind(kind) : true);
  const seen = new Set<string>();
  const scored: Array<{ item: SymbolItem; score: number }> = [];
  index.forEach((m, i) => {
    if (!keep(m.kind)) return;
    const k = dedupeKey(m.path, m.range.start.line, m.name);
    if (seen.has(k)) return;
    seen.add(k);
    // Backend order is authoritative within each tier (exact name / other).
    scored.push({ item: symbolItem(m), score: (isExact(m.name, query) ? 4000 : 3000) - i });
  });
  for (const s of lsp) {
    if (!keep(s.kind)) continue;
    const path = s.location.path;
    const inProject = !!opts.root && (path === opts.root || path.startsWith(opts.root + "/"));
    if (!inProject && !opts.includeNonProject) continue;
    const line = s.location.range.start.line;
    const k = dedupeKey(path, line, s.name);
    if (seen.has(k)) continue;
    const hit = matchText(s.name, query);
    if (!hit) continue;
    seen.add(k);
    const rel = opts.root && inProject ? path.slice(opts.root.length + 1) : path;
    scored.push({
      item: {
        kind: "symbol",
        key: `s:${path}:${line}:${s.location.range.start.col}:${s.name}`,
        name: s.name,
        display: symbolDisplayName(s.name, s.kind),
        symbolKind: s.kind,
        container: s.container,
        path,
        rel,
        line,
        col: s.location.range.start.col,
        indices: hit.indices,
        lsp: true,
      },
      // Exact LSP hits follow exact index hits but beat fuzzy ones.
      score: isExact(s.name, query) ? 3500 : hit.score,
    });
  }
  const sorted = byScore(scored).map((s) => s.item);
  return { items: sorted.slice(0, opts.limit), hasMore: sorted.length > opts.limit };
}

export function matchActions(
  actions: readonly Action[],
  query: string,
  opts: { isEnabled: (a: Action) => boolean; recent: readonly string[]; includeDisabled?: boolean },
): ActionItem[] {
  const q = query.trim();
  if (!q) return [];
  const out: ActionItem[] = [];
  const recentRank = new Map(opts.recent.map((id, i) => [id, i]));
  for (const a of actions) {
    if (a.hidden) continue;
    const enabled = opts.isEnabled(a);
    if (!enabled && opts.includeDisabled === false) continue;
    let score: number;
    let indices: number[] = [];
    const translated = tx(a.title);
    const title = matchText(translated, q, { wordAligned: true });
    // The English title still matches; its indices don't apply to the translated text.
    const english = title || translated === a.title ? undefined : matchText(a.title, q, { wordAligned: true });
    if (title) {
      score = title.score;
      indices = title.indices;
    } else if (english) {
      score = english.score;
    } else {
      const extra = [a.category ? tx(a.category) : "", a.description, ...(a.keywords ?? [])].filter(
        (s): s is string => !!s,
      );
      const best = Math.max(-Infinity, ...extra.map((s) => matchText(s, q, { wordAligned: true })?.score ?? -Infinity));
      const idHit = a.id.toLowerCase().includes(q.toLowerCase()) ? 0 : -Infinity;
      score = Math.max(best, idHit) - 400;
      if (!Number.isFinite(score)) continue;
    }
    if (!enabled) score -= 150;
    const r = recentRank.get(a.id);
    if (r !== undefined) score += 40 - Math.min(30, r * 3);
    out.push({
      kind: "action",
      key: `a:${a.id}`,
      id: a.id,
      title: translated,
      category: a.category ? tx(a.category) : a.category,
      icon: a.icon,
      enabled,
      indices,
      score,
    });
  }
  return byScore(out);
}

export function actionItem(a: Action, enabled: boolean): ActionItem {
  return {
    kind: "action",
    key: `a:${a.id}`,
    id: a.id,
    title: tx(a.title),
    category: a.category ? tx(a.category) : a.category,
    icon: a.icon,
    enabled,
    indices: [],
    score: 0,
  };
}

export function textItems(path: string, rel: string, matches: readonly LineMatch[]): TextItem[] {
  const out: TextItem[] = [];
  for (const m of matches) {
    const lead = m.text.length - m.text.trimStart().length;
    const text = m.text.slice(lead).trimEnd();
    const indices: number[] = [];
    for (const [s, e] of m.ranges)
      for (let i = Math.max(s, lead); i < e; i++) if (i - lead < text.length) indices.push(i - lead);
    const first = m.ranges[0] ?? [0, 0];
    out.push({
      kind: "text",
      key: `t:${path}:${m.line}:${first[0]}`,
      path,
      rel,
      line: m.line,
      col: first[0] + m.textOffset,
      endCol: first[1] + m.textOffset,
      text,
      indices,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rows

export function buildRows(sections: ReadonlyMap<SectionId, SectionState>, opts: { headers: boolean }): SeRow[] {
  const rows: SeRow[] = [];
  for (const id of SECTION_ORDER) {
    const s = sections.get(id);
    if (!s || !s.items.length) continue;
    if (opts.headers) rows.push({ kind: "section", key: `#${id}`, section: id, title: SECTION_TITLES[id] });
    for (const item of s.items) rows.push({ ...item, section: id });
    if (s.hasMore) rows.push({ kind: "more", key: `+${id}`, section: id });
  }
  return rows;
}

export const isSectionRow = (r: SeRow) => r.kind === "section";

/**
 * Whether the top result is final: every section above the first one with
 * items has finished. Enter typed before that waits (IDEA opens the first
 * result of the new query, never a stale row of the previous one).
 */
export function topResultSettled(sections: ReadonlyMap<SectionId, SectionState>): boolean {
  for (const id of SECTION_ORDER) {
    const s = sections.get(id);
    if (!s) continue;
    if (s.loading) return false;
    if (s.items.length) return true;
  }
  return true;
}

/**
 * Keeps the selection on the same item while results stream in: returns the
 * index of `key` if still present, otherwise the first selectable row
 * (or the clamped previous index after the user navigated).
 */
export function stableIndex(rows: readonly SeRow[], key: string | null, prevIndex: number, userMoved: boolean): number {
  if (key) {
    const i = rows.findIndex((r) => r.key === key);
    if (i >= 0) return i;
  }
  if (userMoved && prevIndex >= 0 && rows.length) {
    for (let i = Math.min(prevIndex, rows.length - 1); i >= 0; i--) if (!isSectionRow(rows[i]!)) return i;
  }
  return rows.findIndex((r) => !isSectionRow(r));
}
