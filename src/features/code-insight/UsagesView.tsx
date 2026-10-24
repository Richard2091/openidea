/** "usages" tool window: Find Usages results grouped by file with line previews. */
import { useCallback, useMemo, useState } from "react";
import { formatMessage, useTx } from "@/platform/i18n";
import { basename, relativeDir, useProject } from "@/platform/project";
import { EmptyState, Icon, IconButton, Spinner, Tabs, Tree, fileIconName, type TreeRowState, T } from "@/ui";
import { openLocation } from "./ipc";
import { trimPreview, usageCount, useUsages, type Usage, type UsageGroup } from "./usages";
import styles from "./UsagesView.module.css";

type Node =
  | { kind: "summary"; key: string }
  | { kind: "file"; key: string; group: UsageGroup }
  | { kind: "usage"; key: string; usage: Usage };

export function UsagePreview({ usage }: { usage: Usage }) {
  const { text, from, to } = trimPreview(usage);
  return (
    <span className={styles.preview}>
      {text.slice(0, from)}
      <mark className={styles.match}>{text.slice(from, to)}</mark>
      {text.slice(to)}
    </span>
  );
}

/** Tool window header: the current search as a content tab (`Usages of 'foo'`). */
export function UsagesTabs() {
  const tx = useTx();
  const search = useUsages((s) => s.search);
  if (!search) return null;
  const label = search.symbol ? formatMessage(tx("Usages of '{symbol}'"), { symbol: search.symbol }) : tx("Usages");
  return (
    <Tabs
      variant="compact"
      className={styles.tabs}
      aria-label="Usage searches"
      items={[{ id: String(search.id), label }]}
      activeId={String(search.id)}
      onSelect={() => undefined}
    />
  );
}

const SUMMARY_KEY = "\u0000summary";

export function UsagesView() {
  const tx = useTx();
  const search = useUsages((s) => s.search);
  const root = useProject((s) => s.project?.root ?? "");
  const [collapsed, setCollapsed] = useState<{ id: number | null; keys: ReadonlySet<string> }>({
    id: null,
    keys: new Set(),
  });
  const files = useMemo<Node[]>(
    () => (search?.groups ?? []).map((g) => ({ kind: "file", key: g.path, group: g })),
    [search?.groups],
  );
  const roots = useMemo<Node[]>(() => (files.length ? [{ kind: "summary", key: SUMMARY_KEY }] : []), [files.length]);
  const searchId = search?.id ?? null;
  const expanded = useMemo(() => {
    const hidden = collapsed.id === searchId ? collapsed.keys : new Set<string>();
    return new Set([SUMMARY_KEY, ...files.map((r) => r.key)].filter((k) => !hidden.has(k)));
  }, [files, collapsed, searchId]);
  const getChildren = useCallback(
    (n: Node): Node[] | undefined =>
      n.kind === "summary"
        ? files
        : n.kind === "file"
          ? n.group.usages.map((u) => ({ kind: "usage", key: `${u.path}:${u.line}:${u.col}`, usage: u }) as Node)
          : undefined,
    [files],
  );

  if (!search)
    return (
      <EmptyState>
        <T>Use Find Usages (⌥F7) on a symbol to see its usages here</T>
      </EmptyState>
    );
  const total = usageCount(search.groups);
  const setAll = (collapse: boolean) =>
    setCollapsed({ id: search.id, keys: collapse ? new Set(files.map((f) => f.key)) : new Set() });

  const renderNode = (n: Node, _state: TreeRowState) => {
    if (n.kind === "summary")
      return (
        <span className={styles.row}>
          <span className={styles.groupLabel}>
            <T>Found usages</T>
          </span>
          <span className={styles.count}>
            {total} {tx(total === 1 ? "result" : "results")}
          </span>
          {search.note && <span className={styles.note}>{search.note}</span>}
        </span>
      );
    if (n.kind === "file") {
      const path = n.group.path;
      return (
        <span className={styles.row}>
          <Icon name={fileIconName(basename(path))} size={16} className={styles.icon} />
          <span className={styles.file}>{basename(path)}</span>
          <span className={styles.muted}>{relativeDir(root, path)}</span>
          <span className={styles.count}>
            {n.group.usages.length} {tx(n.group.usages.length === 1 ? "usage" : "usages")}
          </span>
        </span>
      );
    }
    return (
      <span className={styles.row}>
        <span className={styles.line}>{n.usage.line + 1}</span>
        <UsagePreview usage={n.usage} />
      </span>
    );
  };

  return (
    <div className={styles.view}>
      <div className={styles.toolbar} role="toolbar" aria-orientation="vertical" aria-label="Usages actions">
        <IconButton
          icon="rerun"
          title={tx("Rerun Find Usages")}
          size="small"
          iconSize={16}
          disabled={!search.rerun}
          onClick={() => search.rerun?.()}
        />
        <span className={styles.toolbarSep} />
        <IconButton icon="expand-all" title="Expand All" size="small" iconSize={16} onClick={() => setAll(false)} />
        <IconButton icon="collapse-all" title="Collapse All" size="small" iconSize={16} onClick={() => setAll(true)} />
      </div>
      <div className={styles.body}>
        {(search.loading || search.error) && (
          <div className={styles.summary} role="status" aria-live="polite">
            {search.loading ? (
              <>
                <Spinner size={12} />{" "}
                {search.symbol
                  ? formatMessage(tx("Searching for usages of '{symbol}'"), { symbol: search.symbol })
                  : tx("Searching for usages")}
                …
              </>
            ) : (
              <span className={styles.error}>{search.error}</span>
            )}
          </div>
        )}
        <Tree<Node>
          key={search.id}
          aria-label="Usages"
          roots={roots}
          getKey={(n) => n.key}
          getLabel={(n) =>
            n.kind === "summary" ? tx("Found usages") : n.kind === "file" ? basename(n.group.path) : n.usage.text.trim()
          }
          getChildren={getChildren}
          isExpandable={(n) => n.kind !== "usage"}
          expanded={expanded}
          onExpandedChange={(next) =>
            setCollapsed({
              id: search.id,
              keys: new Set([SUMMARY_KEY, ...files.map((f) => f.key)].filter((k) => !next.has(k))),
            })
          }
          renderNode={renderNode}
          multiSelect={false}
          onActivate={(n) => {
            const u = n.kind === "usage" ? n.usage : n.kind === "file" ? n.group.usages[0] : undefined;
            if (u) openLocation(u.path, u.line, u.col);
          }}
          empty={
            !search.loading && !search.error ? (
              <EmptyState>
                <T>No usages found</T>
              </EmptyState>
            ) : undefined
          }
        />
      </div>
    </div>
  );
}
