/**
 * Search & navigation: Search Everywhere (⇧⇧ and the Go to … choosers),
 * Recent Files / Recent Locations, Find / Replace in Files + the Find tool
 * window, the Structure tool window + File Structure popup, and bookmarks.
 */
import { lazyComponent } from "@/ui";
import { activeEditor, registerEditorContribution } from "@/editor/api";
import { executeAction, registerActions } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { registerMenuGroup, registerOverlay, registerToolWindow } from "@/workbench/contributions";
import { bookmarkGutter } from "./bookmarks/gutter";
import {
  hasBookmark,
  loadBookmarks,
  renameBookmarks,
  toggleBookmark,
  updateBookmarks,
  useBookmarks,
  type Bookmark,
} from "./bookmarks/store";
import { maybeToolWindowService } from "./common/services";
import { openLocation } from "./common/open";
import { installTracking, resetTracking } from "./common/tracking";
import { SearchEverywhereOverlay } from "./everywhere/SearchEverywhere";
import { hideSearchEverywhere, showSearchEverywhere } from "./everywhere/store";
import { FindInFilesOverlay } from "./find/FindInFiles";
import { hideFindPopup, parseFindArg, showFindPopup, useFindPopup } from "./find/store";
import { disposeFindWindow } from "./find/windowStore";
import { RecentPopupsOverlay } from "./recent/RecentPopups";
import { cycleSwitcher, hideRecentPopup, showRecentPopup } from "./recent/store";
import { FileStructureOverlay, useFileStructurePopup } from "./structure/StructureView";

/** Single-line editor selection, used to prefill search fields. */
function editorSelectionText(): string | null {
  const view = activeEditor()?.view;
  if (!view) return null;
  const { from, to } = view.state.selection.main;
  if (from === to || to - from > 200) return null;
  const text = view.state.sliceDoc(from, to);
  return text.includes("\n") ? null : text;
}

type PopupKind = "everywhere" | "recent" | "find" | "fileStructure";

function closeAllPopups(except?: PopupKind) {
  if (except !== "everywhere") hideSearchEverywhere();
  if (except !== "recent") hideRecentPopup();
  if (except !== "find") hideFindPopup();
  if (except !== "fileStructure" && useFileStructurePopup.getState().open)
    useFileStructurePopup.setState({ open: false });
}

function jumpBookmark(dir: 1 | -1) {
  const handle = activeEditor();
  const items = useBookmarks.getState().items;
  if (!items.length) return;
  const path = handle?.ctx.path;
  const line = handle ? handle.view.state.doc.lineAt(handle.view.state.selection.main.head).number - 1 : -1;
  const order = items.map((b) => ({ b, k: `${b.path}\u0000${String(b.line).padStart(9, "0")}` }));
  const cur = `${path ?? ""}\u0000${String(line).padStart(9, "0")}`;
  const sorted = order.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const next =
    dir === 1
      ? (sorted.find((x) => x.k > cur) ?? sorted[0])
      : ([...sorted].reverse().find((x) => x.k < cur) ?? sorted[sorted.length - 1]);
  if (next) void openLocation(next.b.path, { line: next.b.line, col: 0 });
}

export function activate(): void | (() => void) {
  const se = (tab: Parameters<typeof showSearchEverywhere>[0]) => () => {
    closeAllPopups("everywhere");
    showSearchEverywhere(tab, { query: editorSelectionText() ?? undefined, toggleOnRepeat: tab === "all" });
  };

  const disposers: Array<() => void> = [
    installTracking(),

    registerOverlay({ id: "search.everywhere", component: SearchEverywhereOverlay }),
    registerOverlay({ id: "search.recent", component: RecentPopupsOverlay }),
    registerOverlay({ id: "search.findInFiles", component: FindInFilesOverlay }),
    registerOverlay({ id: "search.fileStructure", component: FileStructureOverlay }),

    registerToolWindow({
      id: "structure",
      title: "Structure",
      icon: "toolwindow-structure",
      anchor: "left",
      order: 20,
      component: lazyComponent(() => import("./structure/StructureView").then((m) => m.StructureView)),
    }),
    registerToolWindow({
      id: "bookmarks",
      title: "Bookmarks",
      icon: "toolwindow-bookmarks",
      // Same anchor as Project/Structure, so it sits in their stripe group (the lower group holds bottom windows).
      anchor: "left",
      order: 30,
      component: lazyComponent(() => import("./bookmarks/BookmarksView").then((m) => m.BookmarksView)),
      headerActions: lazyComponent(() => import("./bookmarks/BookmarksView").then((m) => m.BookmarksActions)),
      useBadge: () => null,
    }),
    registerToolWindow({
      id: "find",
      title: "Find",
      icon: "toolwindow-find",
      anchor: "bottom",
      stripe: "onUse",
      order: 5,
      component: lazyComponent(() => import("./find/FindToolWindow").then((m) => m.FindToolWindow)),
      headerContent: lazyComponent(() => import("./find/FindToolWindow").then((m) => m.FindTabs)),
      headerActions: lazyComponent(() => import("./find/FindToolWindow").then((m) => m.FindToolWindowActions)),
    }),

    registerEditorContribution({
      id: "search.bookmarks",
      order: 50,
      extensions: (ctx) => bookmarkGutter(ctx.path),
    }),
    registerMenuGroup({
      id: "search.bookmarks",
      menus: ["editorGutter"],
      order: 20,
      items: (_menu, { paths: [path], line }) => {
        if (!path || line == null) return [];
        const on = hasBookmark(useBookmarks.getState().items, path, line);
        return [
          {
            label: on ? "Remove Bookmark" : "Add Bookmark",
            shortcut: shortcutLabel("navigate.toggleBookmark"),
            run: () => void executeAction("navigate.toggleBookmark", { path, line }),
          },
        ];
      },
    }),

    registerActions([
      {
        id: "navigate.searchEverywhere",
        title: "Search Everywhere",
        category: "Navigate",
        icon: "search",
        keywords: ["find", "goto", "everything"],
        run: se("all"),
      },
      {
        id: "navigate.gotoClass",
        title: "Go to Class…",
        category: "Navigate",
        keywords: ["type", "interface", "struct"],
        when: "projectOpen",
        run: se("classes"),
      },
      {
        id: "navigate.gotoFile",
        title: "Go to File…",
        category: "Navigate",
        icon: "file",
        keywords: ["open file"],
        when: "projectOpen",
        run: se("files"),
      },
      {
        id: "navigate.gotoSymbol",
        title: "Go to Symbol…",
        category: "Navigate",
        keywords: ["function", "method", "field"],
        when: "projectOpen",
        run: se("symbols"),
      },
      {
        id: "navigate.findAction",
        title: "Find Action…",
        category: "Help",
        keywords: ["command", "palette"],
        run: se("actions"),
      },
      {
        id: "navigate.searchText",
        title: "Search Text Everywhere",
        category: "Navigate",
        keywords: ["grep", "find text"],
        when: "projectOpen",
        run: se("text"),
      },
      {
        id: "navigate.recentFiles",
        title: "Recent Files",
        category: "Navigate",
        icon: "history",
        keywords: ["switcher"],
        when: "projectOpen",
        run: () => {
          closeAllPopups("recent");
          showRecentPopup("files");
        },
      },
      {
        id: "navigate.switcher",
        title: "Switcher",
        category: "Navigate",
        keywords: ["recent files", "tabs"],
        when: "projectOpen",
        run: () => {
          closeAllPopups("recent");
          cycleSwitcher(1);
        },
      },
      {
        id: "navigate.switcherBack",
        title: "Switcher (Backward)",
        category: "Navigate",
        hidden: true,
        when: "projectOpen",
        run: () => {
          closeAllPopups("recent");
          cycleSwitcher(-1);
        },
      },
      {
        id: "navigate.recentLocations",
        title: "Recent Locations",
        category: "Navigate",
        icon: "clock",
        when: "projectOpen",
        run: () => {
          closeAllPopups("recent");
          showRecentPopup("locations");
        },
      },
      {
        id: "find.inPath",
        title: "Find in Files…",
        category: "Find",
        icon: "search",
        keywords: ["grep", "search in path"],
        when: "projectOpen",
        run: ({ arg }) => {
          closeAllPopups("find");
          showFindPopup(false, { ...parseFindArg(arg), selection: editorSelectionText() });
        },
      },
      {
        id: "find.replaceInPath",
        title: "Replace in Files…",
        category: "Find",
        icon: "replace",
        when: "projectOpen",
        run: ({ arg }) => {
          closeAllPopups("find");
          showFindPopup(true, { ...parseFindArg(arg), selection: editorSelectionText() });
        },
      },
      {
        id: "navigate.fileStructure",
        title: "File Structure",
        category: "Navigate",
        icon: "structure",
        keywords: ["outline", "members"],
        run: () => {
          closeAllPopups("fileStructure");
          useFileStructurePopup.setState((s) => ({ open: !s.open }));
        },
      },
      {
        id: "navigate.toggleBookmark",
        title: "Toggle Bookmark",
        category: "Bookmarks",
        icon: "bookmark",
        when: "projectOpen",
        run: ({ arg }) => {
          const a = (arg ?? {}) as { path?: unknown; line?: unknown };
          if (typeof a.path === "string" && typeof a.line === "number") {
            const { path, line } = a as { path: string; line: number };
            updateBookmarks((list) => toggleBookmark(list, path, line, ""));
            return;
          }
          const handle = activeEditor();
          if (!handle) return;
          const line = handle.view.state.doc.lineAt(handle.view.state.selection.main.head);
          updateBookmarks((list) => toggleBookmark(list, handle.ctx.path, line.number - 1, line.text));
        },
      },
      {
        id: "navigate.showBookmarks",
        title: "Show Bookmarks",
        category: "Bookmarks",
        icon: "bookmark",
        when: "projectOpen",
        run: () => maybeToolWindowService()?.show("bookmarks", true),
      },
      {
        id: "navigate.nextBookmark",
        title: "Next Bookmark",
        category: "Bookmarks",
        when: "projectOpen",
        run: () => jumpBookmark(1),
      },
      {
        id: "navigate.prevBookmark",
        title: "Previous Bookmark",
        category: "Bookmarks",
        when: "projectOpen",
        run: () => jumpBookmark(-1),
      },
    ]),
  ];

  const onProject = (root: string | null) => {
    closeAllPopups();
    disposeFindWindow();
    loadBookmarks(root);
  };
  onProject(useProject.getState().project?.root ?? null);
  disposers.push(
    useProject.subscribe((s, prev) => {
      if (s.project?.root === prev.project?.root) return;
      onProject(s.project?.root ?? null);
      resetTracking();
      // A directory scope pointed into the previous project.
      if (useFindPopup.getState().scopeTab === "directory")
        useFindPopup.setState({ scopeTab: "project", directory: "" });
    }),
    onIdeEvent("fsChanged", (e) => {
      if (!e.removed.length) return;
      updateBookmarks((list) => e.removed.reduce<Bookmark[]>((acc, p) => renameBookmarks(acc, p, null), [...list]));
    }),
  );

  return () => {
    closeAllPopups();
    disposeFindWindow();
    disposers.reverse().forEach((d) => d());
  };
}
