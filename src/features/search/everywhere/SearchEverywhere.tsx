import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { actionToggled, executeAction, getAction } from "@/platform/actions";
import type { ProjectFileSet } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import { hasPrimaryModifier, shortcutLabel } from "@/platform/keymap";
import {
  Checkbox,
  Dialog,
  HighlightedText,
  Icon,
  IconButton,
  List,
  Menu,
  Spinner,
  SymbolBadge,
  Select,
  Toggle,
  fileIconName,
  listNavigate,
  type MenuItem,
  T,
} from "@/ui";
import { useFileDecoration } from "@/workbench/contributions";
import { badgeKind, basename, openLocation, relDir } from "../common/open";
import { parseLocationQuery } from "../common/query";
import { SeController, type SeSnapshot } from "./controller";
import { ipcDeps } from "./deps";
import {
  MORE_STEP_ALL,
  MORE_STEP_TAB,
  SECTION_TITLES,
  TABS,
  buildRows,
  isSectionRow,
  stableIndex,
  topResultSettled,
  type SeRow,
  type SeTab,
  type SectionId,
} from "./model";
import { hideSearchEverywhere, pushRecentAction, useSearchEverywhere } from "./store";
import styles from "./SearchEverywhere.module.css";

type SeScope = "allPlaces" | ProjectFileSet;

const SE_SCOPES: Array<{ value: SeScope; label: string }> = [
  { value: "allPlaces", label: "All Places" },
  { value: "all", label: "Project Files" },
  { value: "production", label: "Project Production Files" },
  { value: "test", label: "Project Test Files" },
];

const ROW = 24;
const MAX_LIST = 528;
const DEBOUNCE_MS = 60;

export function SearchEverywhereOverlay() {
  const open = useSearchEverywhere((s) => s.open);
  return open ? <SearchEverywhereDialog /> : null;
}

type Selection = { key: string | null; index: number; moved: boolean };

function SearchEverywhereDialog() {
  const tx = useTx();
  const tab = useSearchEverywhere((s) => s.tab);
  const query = useSearchEverywhere((s) => s.query);
  const includeNonProject = useSearchEverywhere((s) => s.includeNonProject);
  const fileSet = useSearchEverywhere((s) => s.fileSet);
  const session = useSearchEverywhere((s) => s.session);
  const ctx = useSearchEverywhere((s) => s.ctx);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [debounced, setDebounced] = useState(query);
  const [extra, setExtra] = useState<Partial<Record<SectionId, number>>>({});
  const [snap, setSnap] = useState<SeSnapshot | null>(null);
  const [controller] = useState(() => new SeController(ipcDeps(ctx), setSnap));
  const [sel, setSel] = useState<Selection>({ key: null, index: -1, moved: false });
  const [menu, setMenu] = useState<{ anchor: Element; items: MenuItem[] } | null>(null);
  const [toggleTick, setToggleTick] = useState(0);
  const bumpToggles = () => setToggleTick((t) => t + 1);

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    if (query === debounced) return;
    const t = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, debounced]);

  // New query / scope: forget "Show more" and the user's selection.
  const [prevInputs, setPrevInputs] = useState({ debounced, tab });
  if (prevInputs.debounced !== debounced || prevInputs.tab !== tab) {
    setPrevInputs({ debounced, tab });
    setExtra({});
    setSel({ key: null, index: -1, moved: false });
  }

  useEffect(() => {
    controller.run({ query: debounced, tab, includeNonProject, fileSet: tab === "all" ? null : fileSet, extra });
  }, [controller, debounced, tab, includeNonProject, fileSet, extra]);

  useEffect(() => {
    inputRef.current?.select();
  }, [session]);

  const parsed = useMemo(() => parseLocationQuery(debounced), [debounced]);
  const rows = useMemo(
    () => (snap ? buildRows(snap.sections, { headers: !parsed.text.trim() }) : []),
    [snap, parsed.text],
  );
  const active = stableIndex(rows, sel.key, sel.index, sel.moved);
  const activeRow = active >= 0 ? rows[active] : undefined;
  // Rows still answer an older query (debounce / in-flight search): Enter must wait.
  const settled =
    !!snap && query === debounced && snap.query === debounced && snap.tab === tab && topResultSettled(snap.sections);
  const pendingEnter = useRef<{ side: boolean } | null>(null);

  const select = (index: number) => setSel({ key: rows[index]?.key ?? null, index, moved: true });
  const setTab = (t: SeTab) => {
    useSearchEverywhere.setState({ tab: t });
    inputRef.current?.focus();
  };
  const cycleTab = (dir: 1 | -1) => {
    const i = TABS.findIndex((t) => t.id === tab);
    setTab(TABS[(i + dir + TABS.length) % TABS.length]!.id);
  };

  const close = () => hideSearchEverywhere();
  /** Close first so the dialog's focus restore doesn't fight the editor opening. */
  const closeThen = (fn: () => void) => {
    close();
    setTimeout(fn, 0);
  };

  const activate = (row: SeRow | undefined, side = false) => {
    if (!row) return;
    switch (row.kind) {
      case "section":
        return;
      case "more": {
        const step = tab === "all" ? MORE_STEP_ALL : MORE_STEP_TAB;
        setExtra((e) => ({ ...e, [row.section]: (e[row.section] ?? 0) + step }));
        setSel({ key: null, index: rows.indexOf(row), moved: true });
        return;
      }
      case "file":
        return closeThen(
          () => void openLocation(row.path, row.line !== null ? { line: row.line, col: row.col ?? 0 } : null, { side }),
        );
      case "symbol":
        return closeThen(() => void openLocation(row.path, { line: row.line, col: row.col }, { side }));
      case "text":
        return closeThen(
          () =>
            void openLocation(
              row.path,
              { line: row.line, col: row.col, endLine: row.line, endCol: row.endCol },
              { side },
            ),
        );
      case "action":
        if (!row.enabled) return;
        pushRecentAction(row.id);
        if (getAction(row.id)?.toggled) {
          void executeAction(row.id).then(() => bumpToggles());
          return;
        }
        return closeThen(() => void executeAction(row.id));
    }
  };

  useEffect(() => {
    const pending = pendingEnter.current;
    if (!pending || !settled) return;
    pendingEnter.current = null;
    activate(activeRow, pending.side);
  });

  const openIntentions = () => {
    const row = activeRow;
    if (!row || row.kind === "section" || row.kind === "more") return;
    const anchor = listRef.current?.querySelector('[aria-selected="true"]') ?? inputRef.current;
    if (!anchor) return;
    const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});
    const items: MenuItem[] =
      row.kind === "action"
        ? [
            { label: "Execute", disabled: !row.enabled, run: () => activate(row) },
            { kind: "separator" },
            { label: "Copy Action ID", run: () => copy(row.id) },
          ]
        : [
            { label: "Open", run: () => activate(row) },
            { label: "Open to the Side", shortcut: "⇧↵", run: () => activate(row, true) },
            { kind: "separator" },
            { label: "Copy Path", run: () => copy(row.path) },
            { label: "Copy Path from Project Root", run: () => copy(row.rel) },
            ...(row.kind === "symbol" ? [{ label: "Copy Name", run: () => copy(row.name) }] : []),
            ...(row.kind === "file" || row.kind === "text"
              ? [
                  {
                    label: "Find in Directory…",
                    run: () => closeThen(() => void executeAction("find.inPath", { directory: dirOf(row.path) })),
                  },
                ]
              : []),
          ];
    setMenu({ anchor, items });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      cycleTab(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.altKey) openIntentions();
      else if (hasPrimaryModifier(e) && tab === "text")
        closeThen(() => void executeAction("find.inPath", { query: parsed.text }));
      else if (!settled && !sel.moved) pendingEnter.current = { side: e.shiftKey };
      else activate(activeRow, e.shiftKey);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(e.key)) return;
    const next = listNavigate(e.key, { items: rows, active, isSection: isSectionRow, wrap: true, pageSize: 10 });
    if (next === null) return;
    e.preventDefault();
    select(next);
  };

  const listHeight = Math.min(MAX_LIST, rows.length * ROW);
  const emptyQuery = !parsed.text.trim();
  const showEmpty = !rows.length && snap && !snap.loading && (!emptyQuery || tab !== "all");
  const canSplit =
    !!activeRow && activeRow.kind !== "section" && activeRow.kind !== "more" && activeRow.kind !== "action";
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    cycleTab(e.key === "ArrowRight" ? 1 : -1);
  };

  return (
    <Dialog
      open
      onClose={close}
      width={670}
      position="top"
      transparentBackdrop
      aria-label={tx("Search Everywhere")}
      className={styles.dialog}
    >
      <div className={styles.header}>
        <div role="tablist" aria-label={tx("Search scope")} className={styles.tabs} onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === tab}
              tabIndex={t.id === tab ? 0 : -1}
              className={clsx(styles.tab, t.id === tab && styles.tabActive)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setTab(t.id)}
            >
              <T>{t.label}</T>
            </button>
          ))}
        </div>
        {tab === "all" || tab === "actions" ? (
          <Checkbox
            className={styles.include}
            checked={includeNonProject}
            onChange={(v) => {
              useSearchEverywhere.setState({ includeNonProject: v });
              inputRef.current?.focus();
            }}
            label="Include non-project items"
          />
        ) : (
          // IDEA's scope chooser of the Classes / Files / Symbols / Text tabs.
          <Select<SeScope>
            className={styles.include}
            value={includeNonProject ? "allPlaces" : fileSet}
            options={SE_SCOPES}
            onChange={(v) => {
              useSearchEverywhere.setState(
                v === "allPlaces" ? { includeNonProject: true } : { includeNonProject: false, fileSet: v },
              );
              inputRef.current?.focus();
            }}
            aria-label="Search scope"
          />
        )}
        <IconButton
          icon="external-link"
          size="small"
          className={styles.headerButton}
          title={tx("Open in Find Tool Window")}
          shortcut={tab === "text" ? "⌘↵" : undefined}
          onClick={() => closeThen(() => void executeAction("find.inPath", { query: parsed.text }))}
        />
      </div>
      <div className={styles.queryRow}>
        <div className={styles.field}>
          <Icon name="search" size={16} className={styles.magnifier} />
          <input
            id="se-query"
            ref={inputRef}
            data-autofocus
            className={styles.query}
            value={query}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            role="combobox"
            aria-expanded
            aria-controls="se-results"
            aria-autocomplete="list"
            aria-label={tx("Search query")}
            onChange={(e) => useSearchEverywhere.setState({ query: e.target.value })}
            onKeyDown={onKeyDown}
          />
          {snap?.loading && !emptyQuery && <Spinner size={14} className={styles.spinner} />}
          <span className={styles.hint} aria-hidden>
            <T>{hintFor(tab)}</T>
          </span>
        </div>
      </div>
      {(rows.length > 0 || showEmpty) && (
        <div
          ref={listRef}
          id="se-results"
          className={styles.results}
          style={{ height: rows.length ? listHeight + 8 : undefined }}
        >
          {rows.length > 0 && (
            <List<SeRow>
              items={rows}
              getKey={(r) => r.key}
              isSection={isSectionRow}
              renderSection={(r) => (
                <span className={styles.section}>{r.kind === "section" ? <T>{r.title}</T> : ""}</span>
              )}
              activeIndex={active}
              onActiveChange={select}
              onActivate={(r, _i, e) => activate(r, (e as MouseEvent).shiftKey)}
              focusable={false}
              rowHeight={ROW}
              sectionHeight={ROW}
              className={styles.list}
              aria-label={tx("Results")}
              renderItem={(r, state) => (
                <ResultRow row={r} active={state.active} toggleTick={toggleTick} onToggled={bumpToggles} />
              )}
            />
          )}
          {showEmpty && (
            <div className={styles.empty}>
              {tx(
                emptyQuery ? "Type to search" : includeNonProject ? "Nothing found" : "Nothing found in project files",
              )}
            </div>
          )}
        </div>
      )}
      {!rows.length && !showEmpty && <div id="se-results" ref={listRef} hidden />}
      {rows.length > 0 && (
        <footer className={styles.footer}>
          <span className={styles.footerInfo}>{describe(activeRow)}</span>
          {canSplit && (
            <button type="button" className={styles.footerLink} onClick={() => activate(activeRow, true)}>
              <T>Open In Right Split</T>
            </button>
          )}
        </footer>
      )}
      <Menu
        open={!!menu}
        anchor={menu?.anchor ?? null}
        items={menu?.items ?? []}
        placement="right-start"
        onClose={() => {
          setMenu(null);
          inputRef.current?.focus();
        }}
      />
    </Dialog>
  );
}

function describe(row: SeRow | undefined): string {
  if (!row) return "";
  switch (row.kind) {
    case "section":
    case "more":
      return "";
    case "action": {
      const a = getAction(row.id);
      return a?.description ?? (row.category ? `${row.category} | ${row.title}` : row.title);
    }
    case "file":
      return row.rel;
    case "symbol":
    case "text":
      return `${row.rel}:${row.line + 1}`;
  }
}

function hintFor(tab: SeTab): string {
  switch (tab) {
    case "text":
      return "⌘↵ to open in Find tool window";
    case "files":
      return "Type file name, path or file:42";
    default:
      return "⇥ to switch scope";
  }
}

function dirOf(path: string) {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : path;
}

function ResultRow({
  row,
  active,
  toggleTick,
  onToggled,
}: {
  row: SeRow;
  active: boolean;
  toggleTick: number;
  onToggled: () => void;
}) {
  const tx = useTx();
  const tone = "strong";
  switch (row.kind) {
    case "section":
      return null;
    case "more":
      return (
        <span className={clsx(styles.name, styles.more)}>
          … {tx("more")} {tx(SECTION_TITLES[row.section]).toLowerCase()}
        </span>
      );
    case "file":
      return <FileRow path={row.path} name={row.name} dir={row.dir} indices={row.nameIndices} line={row.line} />;
    case "symbol":
      return (
        <>
          <SymbolBadge kind={badgeKind(row.symbolKind)} className={styles.icon} />
          <span className={styles.main}>
            <HighlightedText className={styles.name} text={row.display} indices={row.indices} tone={tone} />
            {row.container && <span className={styles.location}>{row.container}</span>}
          </span>
          <span className={styles.right}>
            {row.section === "classes" ? relDir(row.rel) || basename(row.rel) : basename(row.rel)}
          </span>
        </>
      );
    case "action": {
      const shortcut = shortcutLabel(row.id);
      const toggled = actionToggled(getAction(row.id));
      return (
        <span
          className={clsx(styles.actionRow, !row.enabled && styles.disabled)}
          aria-disabled={!row.enabled || undefined}
        >
          <span className={styles.icon}>{row.icon ? <Icon name={row.icon} size={16} /> : null}</span>
          <span className={styles.main}>
            <HighlightedText className={styles.name} text={row.title} indices={row.indices} tone={tone} />
            {shortcut && <span className={clsx(styles.location, styles.shortcut)}>{shortcut}</span>}
          </span>
          {toggled !== undefined ? (
            <span
              className={styles.toggle}
              data-tick={toggleTick}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.preventDefault()}
            >
              <Toggle
                checked={toggled}
                disabled={!row.enabled}
                aria-label={row.title}
                onChange={() => {
                  pushRecentAction(row.id);
                  void executeAction(row.id).then(onToggled);
                }}
              />
            </span>
          ) : (
            row.category && <span className={styles.right}>{row.category}</span>
          )}
        </span>
      );
    }
    case "text":
      return (
        <>
          <span className={styles.icon}>
            <Icon name={fileIconName(basename(row.rel))} size={16} />
          </span>
          <span className={styles.main}>
            <HighlightedText
              className={clsx(styles.name, styles.code)}
              text={row.text}
              indices={row.indices}
              tone={tone}
            />
          </span>
          <span className={clsx(styles.right, active && styles.rightActive)}>
            {basename(row.rel)} {row.line + 1}
          </span>
        </>
      );
  }
}

function FileRow({
  path,
  name,
  dir,
  indices,
  line,
}: {
  path: string;
  name: string;
  dir: string;
  indices: number[];
  line: number | null;
}) {
  const deco = useFileDecoration(path);
  return (
    <>
      <Icon name={fileIconName(name)} size={16} className={styles.icon} />
      <span className={styles.main}>
        <span className={styles.name} style={deco.color ? { color: deco.color } : undefined}>
          <HighlightedText text={name} indices={indices} tone="strong" />
          {line !== null && <span className={styles.lineSuffix}>:{line + 1}</span>}
        </span>
        {dir && <span className={styles.location}>{dir}</span>}
      </span>
    </>
  );
}
