/**
 * Workbench extension points. Features contribute UI here instead of the
 * workbench importing features, so feature folders stay independent:
 *
 *   registerToolWindow({ id: "project", title: "Project", icon: "folder",
 *                        anchor: "left", component: ProjectView });
 *
 * The workbench renders whatever is registered; the action
 * `toolwindow.<id>` toggles it (registered automatically).
 */
import type { ComponentType, ReactNode, RefObject } from "react";
import type { RunConfig } from "@/bindings";
import type { MenuItem } from "@/ui/Menu";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

export type ToolWindowAnchor = "left" | "right" | "bottom";

export interface ToolWindowContribution {
  id: string;
  title: string;
  /** Icon name from `ui/icons`. */
  icon: string;
  anchor: ToolWindowAnchor;
  /** Order within its stripe; lower first. Bottom-of-stripe group when `secondary`. */
  order?: number;
  secondary?: boolean;
  component: ComponentType<{ id: string }>;
  /** Extra header controls, right-aligned (shown on hover like IDEA). */
  headerActions?: ComponentType<{ id: string }>;
  /**
   * Content tabs rendered right after the title (Terminal "Local × + ▾",
   * Run sessions…). The header then gets a bottom divider.
   */
  headerContent?: ComponentType<{ id: string }>;
  /** The content tabs name the window themselves (IDEA's Commit | Shelf | Stash): no title. */
  tabsReplaceTitle?: boolean;
  /**
   * Window-specific entries of the header's "⋮" options menu, shown above the
   * generic ones (Move to, Maximize, Hide). Either static items or a React
   * hook returning items (may read stores, e.g. for checked state). When
   * present the header title also gets a "▾" opening just these items.
   */
  headerMenu?: MenuItem[] | ((id: string) => MenuItem[]);
  /** Badge (e.g. problem count) shown on the stripe button. */
  useBadge?: () => number | string | null;
  /** Only shown when a project is open (default true). */
  requiresProject?: boolean;
  /**
   * Whether the stripe has a button before the user decides (IDEA): "shown",
   * or "onUse" — listed under the stripe's "…" until first opened (Find, Run…).
   */
  stripe?: "shown" | "onUse";
}

export type StatusAlign = "left" | "right";

export interface StatusItemContribution {
  id: string;
  align: StatusAlign;
  /** Higher = further from the centre (closer to the window edge). */
  priority: number;
  component: ComponentType;
  /**
   * Name in the status bar context menu, where the user can hide or show the
   * widget (IDEA's "Status Bar Widgets"). Untitled items are always shown.
   */
  title?: string;
  /** Shown until the user decides otherwise (default true). */
  defaultVisible?: boolean;
}

/** Title bar widget (VCS branch, run configuration, run/debug buttons…). */
export interface TitleItemContribution {
  id: string;
  align: "left" | "right";
  /** Higher = further from the centre (closer to the window edge). */
  priority: number;
  component: ComponentType;
}

/** Popups / dialogs rendered above the workbench (Search Everywhere, Settings…). */
export interface OverlayContribution {
  id: string;
  component: ComponentType;
}

/** Editor tab types other than text files: diff viewer, settings, welcome… */
export interface EditorKindContribution {
  kind: string;
  component: ComponentType<{ input: EditorInput }>;
  title: (input: EditorInput) => string;
  icon?: (input: EditorInput) => string;
}

/**
 * A view in the Services tool window (IDEA's Services: Docker, HTTP requests,
 * database consoles…), one header tab each.
 */
export interface ServiceViewContribution {
  id: string;
  title: string;
  icon: string;
  /** Tab order; lower first. */
  order?: number;
  component: ComponentType;
  /** Extra Services header controls while this view is selected. */
  headerActions?: ComponentType;
  /** Listed only once shown with `showServiceView` (a request ran…), like `stripe: "onUse"`. */
  onUse?: boolean;
}

export interface EditorInput {
  kind: string; // "file" for text documents
  /** Stable key; tabs with equal keys are the same tab. */
  key: string;
  path?: string;
  data?: unknown;
}

interface Contributions {
  toolWindows: Map<string, ToolWindowContribution>;
  statusItems: Map<string, StatusItemContribution>;
  overlays: Map<string, OverlayContribution>;
  editorKinds: Map<string, EditorKindContribution>;
  titleItems: Map<string, TitleItemContribution>;
  serviceViews: Map<string, ServiceViewContribution>;
}

export const useContributions = create<Contributions>(() => ({
  toolWindows: new Map(),
  statusItems: new Map(),
  overlays: new Map(),
  editorKinds: new Map(),
  titleItems: new Map(),
  serviceViews: new Map(),
}));

function register<K extends keyof Contributions>(
  key: K,
  id: string,
  value: Contributions[K] extends Map<string, infer V> ? V : never,
) {
  useContributions.setState(
    (s) => ({ [key]: new Map(s[key] as Map<string, unknown>).set(id, value) }) as Partial<Contributions>,
  );
  return () =>
    useContributions.setState((s) => {
      const current = s[key] as Map<string, unknown>;
      // A later registration with the same id replaced this one; leave it.
      if (current.get(id) !== value) return s;
      const next = new Map(current);
      next.delete(id);
      return { [key]: next } as Partial<Contributions>;
    });
}

export const registerToolWindow = (c: ToolWindowContribution) => register("toolWindows", c.id, c);
export const registerStatusItem = (c: StatusItemContribution) => register("statusItems", c.id, c);
export const registerOverlay = (c: OverlayContribution) => register("overlays", c.id, c);
export const registerEditorKind = (c: EditorKindContribution) => register("editorKinds", c.kind, c);
export const registerTitleItem = (c: TitleItemContribution) => register("titleItems", c.id, c);
export const registerServiceView = (c: ServiceViewContribution) => register("serviceViews", c.id, c);

/** The Services tool window, which hosts the service views. */
export const SERVICES_WINDOW = "services";
export const useActiveServiceView = create<{ active: string | null; used: ReadonlySet<string> }>(() => ({
  active: null,
  used: new Set(),
}));

/** Selects a service view and opens the Services tool window. */
export function showServiceView(id: string, focus = false) {
  useActiveServiceView.setState((s) => ({ active: id, used: s.used.has(id) ? s.used : new Set(s.used).add(id) }));
  toolWindowService().show(SERVICES_WINDOW, focus);
}

// ---------------------------------------------------------------------------
// Workbench slots: single components owned by one feature.

interface WorkbenchSlots {
  /** Renders editor tabs + editors (the editor feature). */
  editorArea?: ComponentType;
  /** Shown instead of the workbench when no project is open (recent projects…). */
  welcome?: ComponentType;
  /** The title bar project widget's popup (open / recent projects). */
  projectPopup?: ComponentType<ProjectPopupProps>;
}

export interface ProjectPopupProps {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
}

export const useWorkbenchSlots = create<WorkbenchSlots>(() => ({}));

function provideSlot<K extends keyof WorkbenchSlots>(slot: K, component: NonNullable<WorkbenchSlots[K]>): () => void {
  useWorkbenchSlots.setState({ [slot]: component });
  return () => {
    if (useWorkbenchSlots.getState()[slot] === component) useWorkbenchSlots.setState({ [slot]: undefined });
  };
}

export const provideEditorArea = (component: ComponentType) => provideSlot("editorArea", component);
export const provideWelcomeView = (component: ComponentType) => provideSlot("welcome", component);
export const provideProjectPopup = (component: ComponentType<ProjectPopupProps>) =>
  provideSlot("projectPopup", component);

// ---------------------------------------------------------------------------
// File editors: `openFile` asks providers whether a path opens in another
// editor kind (images, hex view) before the text editor. A provider may probe
// the file (size, binary content); the first non-null answer wins.

export interface FileEditorProvider {
  id: string;
  /** Lower asks first. Default 100. */
  order?: number;
  resolve(path: string): EditorInput | null | Promise<EditorInput | null>;
}

const fileEditorProviders = new Map<string, FileEditorProvider>();

export function registerFileEditorProvider(p: FileEditorProvider): () => void {
  fileEditorProviders.set(p.id, p);
  return () => {
    if (fileEditorProviders.get(p.id) === p) fileEditorProviders.delete(p.id);
  };
}

/** The non-text editor input for `path`, or null for the text editor. Provider failures fall through. */
export async function resolveFileEditor(path: string): Promise<EditorInput | null> {
  const providers = [...fileEditorProviders.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  for (const p of providers) {
    try {
      const input = await p.resolve(path);
      if (input) return input;
    } catch (e) {
      console.warn(`file editor provider ${p.id} failed`, e);
    }
  }
  return null;
}

/**
 * Text editor wrappers: render around the text editor of matching files, e.g.
 * Markdown's "Editor and Preview" split. The wrapper must render `children`
 * (the editor) at all times, hiding it with CSS when needed, so the document
 * view stays alive.
 */
export interface TextEditorWrapperContribution {
  id: string;
  matches(path: string): boolean;
  component: ComponentType<{ path: string; tabId: string; children: ReactNode }>;
}

export const useTextEditorWrappers = create<{ wrappers: Map<string, TextEditorWrapperContribution> }>(() => ({
  wrappers: new Map(),
}));

export function registerTextEditorWrapper(w: TextEditorWrapperContribution): () => void {
  useTextEditorWrappers.setState((s) => ({ wrappers: new Map(s.wrappers).set(w.id, w) }));
  return () =>
    useTextEditorWrappers.setState((s) => {
      if (s.wrappers.get(w.id) !== w) return s;
      const wrappers = new Map(s.wrappers);
      wrappers.delete(w.id);
      return { wrappers };
    });
}

export function textEditorWrapperFor(
  wrappers: ReadonlyMap<string, TextEditorWrapperContribution>,
  path: string,
): TextEditorWrapperContribution | undefined {
  for (const w of wrappers.values()) if (w.matches(path)) return w;
  return undefined;
}

// ---------------------------------------------------------------------------
// Services implemented by one feature and consumed by others. The provider
// calls `provide*` during activation; consumers call through the accessor.

export interface OpenOptions {
  /** Select / reveal this range (0-based line, UTF-16 col). */
  selection?: { line: number; col: number; endLine?: number; endCol?: number };
  /** Preview tab (replaced by the next preview), like IDEA's preview tab. */
  preview?: boolean;
  /** Open to the side (split right). */
  side?: boolean;
  focus?: boolean;
  /** Open in the text editor even when a file editor provider claims the file (SVG as text). */
  asText?: boolean;
}

export interface EditorService {
  openFile(path: string, options?: OpenOptions): Promise<void>;
  openInput(input: EditorInput, options?: OpenOptions): Promise<void>;
  /** Path of the focused text editor, if any. */
  activePath(): string | null;
  /** Doc id + cursor of the focused text editor. */
  activeCursor(): { doc: number; path: string; line: number; col: number; offset: number } | null;
  /** Save all dirty documents. */
  saveAll(): Promise<void>;
  /** Move keyboard focus to the active editor (used by Escape from tool windows). */
  focus?(): void;
}

export interface ToolWindowService {
  show(id: string, focus?: boolean): void;
  hide(id: string): void;
  toggle(id: string): void;
  isVisible(id: string): boolean;
}

export interface NotificationService {
  notify(n: {
    level: "info" | "warning" | "error";
    title: string;
    body?: ReactNode;
    actions?: Array<{ label: string; run: () => void }>;
    /** Keep the balloon until dismissed (errors are sticky by default). */
    sticky?: boolean;
    /** Replaces an earlier notification with the same key. */
    key?: string;
    /**
     * Notification group (Settings › Notifications): `system` (default), `lsp`,
     * `vcs`, `run`, `tools`, `plugins`, `search`, `updates`.
     */
    group?: string;
  }): void;
  /** Hides the balloon of the notification with `key` (it stays in the log), e.g. once its cause is gone. */
  expire?(key: string): void;
}

const services: {
  editor?: EditorService;
  toolWindows?: ToolWindowService;
  notifications?: NotificationService;
} = {};

function need<T>(s: T | undefined, name: string): T {
  if (!s) throw new Error(`${name} service not provided yet`);
  return s;
}

export const provideEditorService = (s: EditorService) => void (services.editor = s);
export const provideToolWindowService = (s: ToolWindowService) => void (services.toolWindows = s);
export const provideNotificationService = (s: NotificationService) => void (services.notifications = s);

export const editorService = (): EditorService => need(services.editor, "editor");
export const toolWindowService = (): ToolWindowService => need(services.toolWindows, "toolWindows");
export const notifications = (): NotificationService =>
  services.notifications ?? { notify: (n) => console.info(`[${n.level}] ${n.title}`) };
/** The editor service if one has been provided (for optional integrations). */
export const maybeEditorService = (): EditorService | undefined => services.editor;

// ---------------------------------------------------------------------------
// File decorations: colour / badge / tooltip for a path, shown by the project
// tree, editor tabs, Search Everywhere, etc. Providers (VCS status, problems)
// push decorations into this store; consumers read with `useFileDecoration`.

export interface FileDecoration {
  /** CSS colour, normally a token like `var(--vcs-modified)`. */
  color?: string;
  /** Short badge text, e.g. a problem count. */
  badge?: string;
  tooltip?: string;
  /** Wavy-underline style emphasis for files with errors (IDEA red underline). */
  error?: boolean;
  /** Dim the entry (ignored/excluded). */
  faded?: boolean;
  /** Also decorate ancestor folders (VCS changes, errors). */
  propagate?: boolean;
  /** The path is a folder whose whole content shares this decoration (untracked / ignored folder). */
  subtree?: boolean;
}

interface FileDecorationsState {
  /** provider id → (path → decoration). Later providers win per field. */
  providers: Map<string, Map<string, FileDecoration>>;
  /** Folder paths that contain decorated descendants, per provider. */
  folders: Map<string, Map<string, FileDecoration>>;
  /** `subtree` decorations per provider: folder → decoration for everything below it. */
  subtrees: Map<string, Map<string, FileDecoration>>;
}

export const useFileDecorations = create<FileDecorationsState>(() => ({
  providers: new Map(),
  folders: new Map(),
  subtrees: new Map(),
}));

const providerOrder = ["vcs", "problems"];

/** Replaces all decorations of one provider. */
export function setFileDecorations(provider: string, decorations: Map<string, FileDecoration>) {
  const folders = new Map<string, FileDecoration>();
  const subtrees = new Map<string, FileDecoration>();
  for (const [path, d] of decorations) {
    if (d.subtree) subtrees.set(path, { color: d.color, tooltip: d.tooltip, faded: d.faded, error: d.error });
    if (!d.propagate) continue;
    for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
      const dir = path.slice(0, i);
      const prev = folders.get(dir);
      folders.set(dir, { color: prev?.color ?? d.color, error: prev?.error || d.error });
    }
  }
  useFileDecorations.setState((s) => ({
    providers: new Map(s.providers).set(provider, decorations),
    folders: new Map(s.folders).set(provider, folders),
    subtrees: new Map(s.subtrees).set(provider, subtrees),
  }));
}

/** Nearest `subtree` decoration of an ancestor folder of `path`. */
function inherited(path: string, subtrees: Map<string, FileDecoration> | undefined): FileDecoration | undefined {
  if (!subtrees?.size) return undefined;
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    const d = subtrees.get(path.slice(0, i));
    if (d) return d;
  }
  return undefined;
}

function merged(path: string, s: FileDecorationsState): FileDecoration | undefined {
  let out: FileDecoration | undefined;
  const ids = [...s.providers.keys()].sort((a, b) => providerOrder.indexOf(a) - providerOrder.indexOf(b));
  for (const id of ids) {
    const d = s.providers.get(id)?.get(path) ?? s.folders.get(id)?.get(path) ?? inherited(path, s.subtrees.get(id));
    if (d) out = { ...out, ...d };
  }
  return out;
}

export function getFileDecoration(path: string): FileDecoration | undefined {
  return merged(path, useFileDecorations.getState());
}

const NONE: FileDecoration = {};

/** Reactive decoration for `path` (empty object when undecorated). */
export function useFileDecoration(path: string): FileDecoration {
  return useFileDecorations(useShallow((s) => merged(path, s) ?? NONE));
}

// ---------------------------------------------------------------------------
// Settings pages, shown in the Settings dialog (⌘,) tree. Features contribute
// their own pages (e.g. Languages & Servers, Plugins); the settings feature
// renders the tree, search and the page host.

export interface SettingsPageContribution {
  /** Dotted path defines nesting, e.g. `languages.servers`. */
  id: string;
  title: string;
  /** Parent group title for top-level grouping, e.g. "Editor", "Tools". */
  group?: string;
  order?: number;
  /** Extra words matched by the settings search. */
  keywords?: string[];
  component: ComponentType;
}

export const useSettingsPages = create<{ pages: Map<string, SettingsPageContribution> }>(() => ({ pages: new Map() }));

export function registerSettingsPage(page: SettingsPageContribution): () => void {
  useSettingsPages.setState((s) => ({ pages: new Map(s.pages).set(page.id, page) }));
  return () =>
    useSettingsPages.setState((s) => {
      if (s.pages.get(page.id) !== page) return s;
      const pages = new Map(s.pages);
      pages.delete(page.id);
      return { pages };
    });
}

// ---------------------------------------------------------------------------
// Project view roots shown below the project ("Scratches").

export interface ProjectViewRootContribution {
  id: string;
  label: string;
  /** Icon name from `ui/icons`. */
  icon: string;
  /** Folder whose contents the node lists (outside the project). */
  path: string;
  /** Lower first. */
  order?: number;
}

export const useProjectViewRoots = create<{ roots: Map<string, ProjectViewRootContribution> }>(() => ({
  roots: new Map(),
}));

export function registerProjectViewRoot(root: ProjectViewRootContribution): () => void {
  useProjectViewRoots.setState((s) => ({ roots: new Map(s.roots).set(root.id, root) }));
  return () =>
    useProjectViewRoots.setState((s) => {
      if (s.roots.get(root.id) !== root) return s;
      const roots = new Map(s.roots);
      roots.delete(root.id);
      return { roots };
    });
}

/** Registered project view roots in display order. */
export function projectViewRoots(map: ReadonlyMap<string, ProjectViewRootContribution>): ProjectViewRootContribution[] {
  return [...map.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Context menu groups: features add items to the editor, project view and
// editor tab context menus (IDEA's EditorPopupMenu / ProjectViewPopupMenu /
// EditorTabPopupMenu / EditorGutterPopupMenu groups), e.g. "Run 'hi.ts'" from features/run.

export type ContextMenuId = "editor" | "projectView" | "editorTab" | "editorGutter";

export interface MenuGroupContext {
  /** Files / directories the menu is for (absolute paths; a virtual URI for virtual documents). */
  paths: string[];
  /** Per path: whether it is a directory (project view). */
  dirs?: boolean[];
  /** The document text, when the menu is for an open document. */
  text?: string;
  /** Editor menu: 0-based caret line; gutter menu: the clicked line. */
  line?: number;
}

export interface MenuGroupContribution {
  id: string;
  menus: ContextMenuId[];
  /** Lower first. */
  order?: number;
  /** Items for this menu (empty for none); called synchronously while the menu is built. */
  items(menu: ContextMenuId, ctx: MenuGroupContext): MenuItem[];
  /** Optional async preparation before the menu opens (e.g. reading the file), bounded by the caller. */
  prepare?(menu: ContextMenuId, ctx: MenuGroupContext): Promise<void>;
}

const menuGroups = new Map<string, MenuGroupContribution>();

export function registerMenuGroup(group: MenuGroupContribution): () => void {
  menuGroups.set(group.id, group);
  return () => {
    if (menuGroups.get(group.id) === group) menuGroups.delete(group.id);
  };
}

function groupsFor(menu: ContextMenuId): MenuGroupContribution[] {
  return [...menuGroups.values()]
    .filter((g) => g.menus.includes(menu))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

/** Contributed items for `menu`, each non-empty group followed by a separator. */
export function menuGroupItems(menu: ContextMenuId, ctx: MenuGroupContext): MenuItem[] {
  const out: MenuItem[] = [];
  for (const g of groupsFor(menu)) {
    let items: MenuItem[] = [];
    try {
      items = g.items(menu, ctx);
    } catch (e) {
      console.error(`menu group ${g.id} failed`, e);
    }
    if (items.length) out.push(...items, { kind: "separator" });
  }
  return out;
}

/** Runs the groups' `prepare` hooks, giving up after `timeoutMs` so the menu never waits long. */
export async function prepareMenuGroups(menu: ContextMenuId, ctx: MenuGroupContext, timeoutMs = 200): Promise<void> {
  const pending = groupsFor(menu)
    .map((g) => g.prepare?.(menu, ctx).catch(() => undefined))
    .filter((p): p is Promise<void> => !!p);
  if (!pending.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(pending), new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
  clearTimeout(timer);
}

// ---------------------------------------------------------------------------
// Run executors beside Run and Debug (IDEA's "Run with Coverage", "Profile"),
// contributed by features and offered by features/run: the run widget's ⋮
// menu, the gutter ▶ popup and the context menus' "More Run/Debug".

/** What an executor launches for a configuration, and what happens once it exits. */
export interface ExecutorLaunch {
  /** Launched instead of the configuration (the Run tab still shows the configuration). */
  launch: RunConfig;
  /** The process exited (not called when it failed to start). */
  finished(result: { exitCode: number | null; stopped: boolean }): void;
}

export interface RunExecutorContribution {
  /** `coverage`, `profiler`. */
  id: string;
  /** Menu label for a configuration or context, e.g. `Run 'tests' with Coverage`. */
  label(name: string): string;
  icon: string;
  /** Action that runs the selected configuration with this executor (shortcut shown in menus). */
  action: string;
  /** Lower first. */
  order?: number;
  /** Cheap check whether this executor can run `config` (the menu shows it only then). */
  supports(config: RunConfig): boolean;
  /** Plans the launch; null when it can't run (the executor has said why). */
  prepare(config: RunConfig): Promise<ExecutorLaunch | null>;
}

export const useRunExecutors = create<{ executors: Map<string, RunExecutorContribution> }>(() => ({
  executors: new Map(),
}));

export function registerRunExecutor(executor: RunExecutorContribution): () => void {
  useRunExecutors.setState((s) => ({ executors: new Map(s.executors).set(executor.id, executor) }));
  return () =>
    useRunExecutors.setState((s) => {
      if (s.executors.get(executor.id) !== executor) return s;
      const executors = new Map(s.executors);
      executors.delete(executor.id);
      return { executors };
    });
}

/** Registered executors, in order. */
export function runExecutors(map = useRunExecutors.getState().executors): RunExecutorContribution[] {
  return [...map.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}
