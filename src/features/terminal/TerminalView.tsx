import { Fragment, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import clsx from "clsx";
import { useProject } from "@/platform/project";
import { toolWindowService } from "@/workbench/contributions";
import { usePlatform } from "@/platform/platformInfo";
import { commands, isTauri } from "@/platform/ipc";
import {
  IconButton,
  Input,
  Menu,
  Popup,
  showContextMenu,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tabs,
  type MenuItem,
  type TabItem,
} from "@/ui";
import {
  closePane,
  closeTab,
  getSession,
  newTab,
  publishFocus,
  renameTab,
  selectTab,
  tabTitle,
  useTerminals,
  type PaneLayout,
  type TerminalTab,
} from "./store";
import { TerminalFindBar } from "./FindBar";
import styles from "./Terminal.module.css";

const TAB_PREFIX = "openidea-terminal";

function TerminalPane({ sessionKey, autofocus }: { sessionKey: string; autofocus: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const status = useTerminals((s) => s.sessions[sessionKey]?.status);

  useLayoutEffect(() => {
    const el = ref.current;
    const session = getSession(sessionKey);
    if (!el || !session) return;
    session.attach(el);
    return () => session.detach(el);
  }, [sessionKey]);

  return (
    <div
      ref={ref}
      className={clsx(styles.pane, (status === "exited" || status === "error") && styles.exited)}
      tabIndex={-1}
      data-autofocus={autofocus ? "" : undefined}
      onFocus={(e) => {
        // The tool window focuses the pane; hand focus on to xterm's textarea.
        if (e.target === e.currentTarget) getSession(sessionKey)?.focus();
      }}
      onContextMenu={(e) => paneMenu(e, sessionKey)}
    />
  );
}

function paneMenu(e: MouseEvent, key: string) {
  e.preventDefault();
  const session = getSession(key);
  if (!session) return;
  const exited = session.state.status === "exited" || session.state.status === "error";
  const mac = usePlatform.getState().os === "macos";
  const items: MenuItem[] = [
    {
      label: "Copy",
      icon: "copy",
      shortcut: mac ? "⌘C" : "Ctrl+Shift+C",
      disabled: !session.hasSelection,
      run: () => session.copySelection(),
    },
    {
      label: "Paste",
      shortcut: mac ? "⌘V" : "Ctrl+Shift+V",
      run: () => {
        void navigator.clipboard
          ?.readText()
          .then((t) => t && session.paste(t))
          .catch(() => undefined);
      },
    },
    { label: "Select All", run: () => session.term.selectAll() },
    { kind: "separator" },
    { label: "Clear Buffer", shortcut: mac ? "⌘K" : undefined, run: () => session.clear() },
    { kind: "separator" },
    { kind: "action", action: "terminal.splitRight" },
    { kind: "action", action: "terminal.splitDown" },
    { label: "Close Session", icon: "close", run: () => closePane(key) },
  ];
  if (exited)
    items.splice(
      0,
      0,
      { label: "Restart Session", icon: "rerun", run: () => session.restart() },
      { kind: "separator" },
    );
  showContextMenu(e, items);
}

function TabPanes({ tab, active }: { tab: TerminalTab; active: boolean }) {
  return <LayoutNode node={tab.layout} tab={tab} active={active} />;
}

function LayoutNode({ node, tab, active }: { node: PaneLayout; tab: TerminalTab; active: boolean }) {
  if (typeof node === "string") {
    return <TerminalPane sessionKey={node} autofocus={active && node === tab.activePane} />;
  }
  return (
    <SplitGroup orientation={node.orientation} className={styles.split} id={`terminal-split-${node.id}`}>
      {node.children.map((child, i) => {
        const id = typeof child === "string" ? child : child.id;
        return (
          <Fragment key={id}>
            {i > 0 && <SplitHandle />}
            <SplitPanel id={id} minSize={60} className={styles.splitPanel}>
              <LayoutNode node={child} tab={tab} active={active} />
            </SplitPanel>
          </Fragment>
        );
      })}
    </SplitGroup>
  );
}

function RenamePopup({ tab, anchor, onClose }: { tab: TerminalTab; anchor: Element; onClose: () => void }) {
  const [value, setValue] = useState(tabTitle(tab));
  return (
    <Popup open anchor={anchor} onClose={onClose} placement="bottom-start" aria-label="Rename tab" trapFocus>
      <form
        className={styles.rename}
        onSubmit={(e) => {
          e.preventDefault();
          renameTab(tab.id, value);
          onClose();
        }}
      >
        <Input
          data-autofocus=""
          aria-label="Tab name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
      </form>
    </Popup>
  );
}

export function TerminalView() {
  const tabs = useTerminals((s) => s.tabs);
  const activeTab = useTerminals((s) => s.activeTab);
  const root = useProject((s) => s.project?.root);
  const autoCreated = useRef(false);

  // Showing an empty terminal window opens a "Local" tab, like IDEA.
  useEffect(() => {
    if (tabs.length === 0 && root && !autoCreated.current) {
      autoCreated.current = true;
      newTab(root);
    }
    if (tabs.length > 0) autoCreated.current = false;
  }, [tabs.length, root]);

  return (
    <div
      className={styles.root}
      onFocusCapture={(e) => publishFocus(!!(e.target as Element).closest?.("[data-terminal-session]"))}
      onBlurCapture={() => publishFocus(false)}
    >
      <TerminalFindBar sessionKey={tabs.find((t) => t.id === activeTab)?.activePane ?? null} />
      <div className={styles.panels}>
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tabpanel"
            id={`${TAB_PREFIX}-panel-${t.id}`}
            aria-labelledby={`${TAB_PREFIX}-tab-${t.id}`}
            className={styles.panel}
            hidden={t.id !== activeTab}
          >
            <TabPanes tab={t} active={t.id === activeTab} />
          </div>
        ))}
      </div>
    </div>
  );
}

let shellList: Promise<string[]> | null = null;

/** Installed shells, looked up once. */
function availableShells(): Promise<string[]> {
  if (!isTauri()) return Promise.resolve([]);
  shellList ??= commands.termAvailableShells().catch(() => {
    shellList = null;
    return [];
  });
  return shellList;
}

/** "zsh", or "bash (/opt/homebrew/bin/bash)" when several shells share a name. */
export function shellItems(paths: string[]): MenuItem[] {
  const name = (p: string) => p.split(/[\\/]/).pop()!.replace(/\.exe$/i, "");
  return paths.map((p) => ({
    kind: "action",
    action: "terminal.newPredefinedSession",
    arg: p,
    label: paths.filter((q) => name(q) === name(p)).length > 1 ? `${name(p)} (${p})` : name(p),
    icon: "",
  }));
}

/** Session tabs shown in the tool window header: "Local ×  +  ▾". */
export function TerminalTabs() {
  const tabs = useTerminals((s) => s.tabs);
  const activeTab = useTerminals((s) => s.activeTab);
  const sessions = useTerminals((s) => s.sessions);
  const [renaming, setRenaming] = useState<{ id: string; anchor: Element } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shells, setShells] = useState<string[]>([]);
  const menuRef = useRef<HTMLButtonElement>(null);
  const focusRaf = useRef(0);

  const items: TabItem[] = tabs.map((t) => {
    const status = t.panes.map((p) => sessions[p]?.status);
    const dead = status.every((s) => s === "exited" || s === "error");
    return {
      id: t.id,
      label: tabTitle(t),
      closable: true,
      italic: dead,
      color: dead ? "var(--fg-subtle)" : undefined,
      tooltip: sessions[t.activePane]?.cwd,
    };
  });

  const onClose = (id: string) => {
    const last = tabs.length === 1;
    closeTab(id);
    if (last) toolWindowService().hide("terminal");
  };

  const tabMenu = (id: string, e: MouseEvent) => {
    e.preventDefault();
    const anchor = (e.currentTarget as Element) ?? null;
    showContextMenu(e, [
      { label: "Rename Session…", icon: "edit", run: () => setRenaming({ id, anchor }) },
      { kind: "separator" },
      { label: "Close Tab", icon: "close", run: () => onClose(id) },
      {
        label: "Close Other Tabs",
        disabled: tabs.length < 2,
        run: () => tabs.filter((t) => t.id !== id).forEach((t) => closeTab(t.id)),
      },
    ]);
  };

  const renameTarget = renaming && tabs.find((t) => t.id === renaming.id);
  const moreItems: MenuItem[] = [
    { kind: "action", action: "terminal.new" },
    { kind: "separator" },
    { kind: "header", label: "New Predefined Session" },
    ...shellItems(shells),
    { kind: "separator" },
    { kind: "action", action: "terminal.splitRight" },
    { kind: "action", action: "terminal.splitDown" },
    { kind: "separator" },
    { kind: "action", action: "file.settings", arg: "tools.terminal", label: "Settings", icon: "settings" },
  ];

  return (
    <div
      className={styles.tabs}
      onDoubleClick={(e) => {
        const tabEl = (e.target as Element).closest?.<HTMLElement>("[role=tab]");
        const id = tabEl?.id.startsWith(`${TAB_PREFIX}-tab-`) ? tabEl.id.slice(`${TAB_PREFIX}-tab-`.length) : null;
        if (tabEl && id) {
          cancelAnimationFrame(focusRaf.current);
          setRenaming({ id, anchor: tabEl });
        }
      }}
    >
      <Tabs
        variant="compact"
        className={styles.tabStrip}
        aria-label="Terminal sessions"
        items={items}
        activeId={activeTab}
        onSelect={(id) => {
          selectTab(id);
          cancelAnimationFrame(focusRaf.current);
          focusRaf.current = requestAnimationFrame(() => {
            const tab = useTerminals.getState().tabs.find((t) => t.id === id);
            if (tab) getSession(tab.activePane)?.focus();
          });
        }}
        onClose={onClose}
        onContextMenu={tabMenu}
        panelIdPrefix={TAB_PREFIX}
        trailing={
          <div className={styles.tabActions}>
            <IconButton icon="plus" size="small" action="terminal.new" title="New Tab" />
            <IconButton
              ref={menuRef}
              icon="chevron-down"
              size="small"
              title="More Terminal Options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => {
                if (!menuOpen) void availableShells().then(setShells);
                setMenuOpen((v) => !v);
              }}
            />
            <Menu open={menuOpen} anchor={menuRef} items={moreItems} onClose={() => setMenuOpen(false)} />
          </div>
        }
      />
      {renaming && renameTarget && (
        <RenamePopup tab={renameTarget} anchor={renaming.anchor} onClose={() => setRenaming(null)} />
      )}
    </div>
  );
}
