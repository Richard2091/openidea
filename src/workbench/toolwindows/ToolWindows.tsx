import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import clsx from "clsx";
import { create } from "zustand";
import { call, commands } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { Icon, IconButton, Menu, showContextMenu, tooltipAttrs, type MenuItem, T } from "@/ui";
import { FOCUSABLE } from "@/ui/popupState";
import { useContributions, type ToolWindowAnchor, type ToolWindowContribution } from "../contributions";
import { useDistractionFree } from "../distractionFree";
import {
  hideToolWindow,
  moveToolWindow,
  placed,
  resetToolWindowPlacements,
  hasStripeButton,
  removeFromStripe,
  setToolWindowSize,
  showToolWindow,
  stripeGroupOf,
  toggleMaximizeToolWindow,
  toggleToolWindow,
  useToolWindowLayout,
  type StripeGroup,
} from "./store";
import styles from "./ToolWindows.module.css";
import { tx } from "@/platform/i18n";

function byOrder(a: ToolWindowContribution, b: ToolWindowContribution) {
  return (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title);
}

/** Registered tool windows available in the current state (project open or not). */
export function useToolWindows(): ToolWindowContribution[] {
  const map = useContributions((s) => s.toolWindows);
  const placements = useToolWindowLayout((s) => s.placements);
  const hasProject = useProject((s) => !!s.project);
  return useMemo(
    () =>
      [...map.values()]
        .filter((t) => hasProject || t.requiresProject === false)
        .map((t) => placed(t, placements))
        .sort(byOrder),
    [map, hasProject, placements],
  );
}

/** Visible window per anchor, ignoring ids that aren't registered (yet). */
export function useEffectiveVisible(windows: ToolWindowContribution[]): Record<ToolWindowAnchor, string | null> {
  const visible = useToolWindowLayout((s) => s.visible);
  return useMemo(() => {
    const out: Record<ToolWindowAnchor, string | null> = { left: null, right: null, bottom: null };
    for (const a of ["left", "right", "bottom"] as const) {
      const id = visible[a];
      if (id && windows.some((w) => w.id === id && w.anchor === a)) out[a] = id;
    }
    return out;
  }, [visible, windows]);
}

// ---------------------------------------------------------------------------
// Stripes

const GROUP_LABELS: Array<[StripeGroup, string]> = [
  ["left-top", "Left Top"],
  ["left-bottom", "Bottom"],
  ["right-top", "Right Top"],
  ["right-bottom", "Right Bottom"],
];

/** "Move to" submenu (IDEA: tool window options › Move To). */
export function moveToMenu(tw: ToolWindowContribution): MenuItem {
  const current = stripeGroupOf(tw);
  return {
    label: "Move To",
    submenu: [
      ...GROUP_LABELS.map(([group, label]): MenuItem => ({
        id: group,
        label,
        checked: group === current ? true : undefined,
        disabled: group === current,
        run: () => moveToolWindow(tw.id, group),
      })),
      { kind: "separator" },
      { label: "Restore Default Layout", run: resetToolWindowPlacements },
    ],
  };
}

/** Stripe button context menu, as in IDEA: Hide (removes the button), Move to, Show Tool Window Names. */
function stripeButtonMenu(tw: ToolWindowContribution, showNames: boolean): MenuItem[] {
  return [
    { label: "Hide", run: () => removeFromStripe(tw.id) },
    { kind: "separator" },
    moveToMenu(tw),
    { kind: "separator" },
    {
      label: "Show Tool Window Names",
      checked: showNames,
      run: () => {
        resetStripeNames();
        void setShowToolWindowNames(!showNames);
      },
    },
  ];
}

async function setShowToolWindowNames(on: boolean) {
  const settings = await call(commands.settingsSet("global", "appearance.showToolWindowNames", JSON.stringify(on)));
  useProject.setState({ settings });
}

/** Stripe button widths: icons only, and the range with names. */
const STRIPE_ICONS = 32;
const STRIPE_MIN = 44;
const STRIPE_DEFAULT = 56;
const STRIPE_MAX = 96;
const STRIPE_KEY = "openidea.stripes.v1";

type StripeSide = "left" | "right";
/** Per stripe: button width with names, and names shown or hidden by a drag (unset: the setting decides). */
interface StripeSize {
  width: number;
  names?: boolean;
}

function readStripes(): Record<StripeSide, StripeSize> {
  const out: Record<StripeSide, StripeSize> = { left: { width: STRIPE_DEFAULT }, right: { width: STRIPE_DEFAULT } };
  try {
    const raw = JSON.parse(localStorage.getItem(STRIPE_KEY) ?? "null");
    for (const side of ["left", "right"] as const) {
      const v = raw?.[side];
      if (typeof v?.width === "number") out[side].width = Math.min(STRIPE_MAX, Math.max(STRIPE_MIN, v.width));
      if (typeof v?.names === "boolean") out[side].names = v.names;
    }
  } catch {
    /* storage unavailable */
  }
  return out;
}

const useStripes = create<Record<StripeSide, StripeSize>>(readStripes);

function setStripe(side: StripeSide, size: StripeSize) {
  useStripes.setState({ [side]: size });
  try {
    localStorage.setItem(STRIPE_KEY, JSON.stringify(useStripes.getState()));
  } catch {
    /* storage unavailable */
  }
}

/** "Show Tool Window Names" (menu or settings) applies to both stripes again. */
function resetStripeNames() {
  const s = useStripes.getState();
  if (s.left.names === undefined && s.right.names === undefined) return;
  setStripe("left", { width: s.left.width });
  setStripe("right", { width: s.right.width });
}

/**
 * Resize handle on a stripe's inner edge. Dragging sets the stripe's button width;
 * narrower than halfway to the named minimum shows icons only.
 */
function StripeHandle({
  side,
  names,
  width,
  frameRef,
  onPreview,
  onCommit,
}: {
  side: StripeSide;
  names: boolean;
  width: number;
  frameRef: RefObject<HTMLDivElement | null>;
  onPreview: (names: boolean) => void;
  onCommit: (names: boolean, width: number) => void;
}) {
  const sign = side === "left" ? 1 : -1;
  // The stripe follows the pointer; names show from STRIPE_MIN (truncated), icons only below it.
  const resolve = (raw: number) => {
    const px = Math.round(Math.min(STRIPE_MAX, Math.max(STRIPE_ICONS, raw)));
    return px < STRIPE_MIN ? { names: false, width, px } : { names: true, width: px, px };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const stripe = frameRef.current?.querySelector<HTMLElement>(`[data-stripe-side="${side}"]`);
    if (e.button !== 0 || !stripe) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const origin = e.clientX;
    const start = names ? width : STRIPE_ICONS;
    const cursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    let next = { names, width, px: start };
    const move = (ev: globalThis.PointerEvent) => {
      const r = resolve(start + sign * (ev.clientX - origin));
      if (r.names !== next.names) onPreview(r.names);
      next = r;
      stripe.style.setProperty("--stripe-drag", `${r.px}px`);
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      document.body.style.cursor = cursor;
      stripe.style.removeProperty("--stripe-drag");
      onCommit(next.names, next.width);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = ["ArrowLeft", "ArrowRight"].indexOf(e.key);
    if (dir < 0) return;
    e.preventDefault();
    const step = sign * (dir ? 1 : -1) * 8;
    // One step crosses between icons only and the narrowest named width.
    if (!names) {
      if (step > 0) onCommit(true, STRIPE_MIN);
    } else if (width + step < STRIPE_MIN) onCommit(false, width);
    else onCommit(true, Math.min(STRIPE_MAX, width + step));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "Resize tool window bar" : "Resize right tool window bar"}
      tabIndex={0}
      className={clsx(styles.stripeHandle, side === "right" && styles.stripeHandleRight)}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

// Stripe button drag. Pointer events rather than HTML5 drag and drop: with the window's native
// file drop enabled, the webview never sees dragover / drop for drags that start inside it.

type StripeDrop = { group: StripeGroup; before: string | null };

const useStripeDrag = create<{ id: string | null; drop: StripeDrop | null }>(() => ({ id: null, drop: null }));

/** Movement before a press on a stripe button becomes a drag, px. */
const DRAG_THRESHOLD = 4;
/** Set when a drag ends on its own button, so the click that follows doesn't toggle the window. */
let dragEnded = false;

/** Drop position under the pointer: a stripe group and the button to insert before (null: at the end). */
function stripeDropAt(x: number, y: number): StripeDrop | null {
  const nav = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-stripe-side]");
  const side = nav?.dataset.stripeSide;
  if (!nav || (side !== "left" && side !== "right")) return null;
  const spacer = nav.querySelector<HTMLElement>("[data-stripe-spacer]")?.getBoundingClientRect();
  const lower = !!spacer && y > spacer.top + spacer.height / 2;
  let before: string | null = null;
  for (const b of nav.querySelectorAll<HTMLElement>("[data-stripe-button]")) {
    const r = b.getBoundingClientRect();
    if (spacer && r.top > spacer.top !== lower) continue;
    if (y < r.top + r.height / 2) {
      before = b.dataset.stripeButton!;
      break;
    }
  }
  return { group: `${side}-${lower ? "bottom" : "top"}`, before };
}

function startStripeDrag(e: PointerEvent<HTMLButtonElement>, id: string) {
  if (e.button !== 0) return;
  const button = e.currentTarget;
  const start = { x: e.clientX, y: e.clientY };
  let ghost: HTMLElement | null = null;
  const place = (x: number, y: number) => {
    if (ghost) ghost.style.transform = `translate(${x - start.x}px, ${y - start.y}px)`;
  };
  const onMove = (ev: globalThis.PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
      const r = button.getBoundingClientRect();
      ghost = button.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("data-stripe-button");
      ghost.className = clsx(button.className, styles.stripeGhost);
      Object.assign(ghost.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      document.body.appendChild(ghost);
      useStripeDrag.setState({ id, drop: null });
    }
    place(ev.clientX, ev.clientY);
    const drop = stripeDropAt(ev.clientX, ev.clientY);
    const cur = useStripeDrag.getState().drop;
    if (drop?.group !== cur?.group || drop?.before !== cur?.before) useStripeDrag.setState({ drop });
  };
  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    if (!ghost) return;
    ghost.remove();
    const { drop } = useStripeDrag.getState();
    useStripeDrag.setState({ id: null, drop: null });
    dragEnded = true;
    setTimeout(() => (dragEnded = false));
    if (commit && drop && drop.before !== id) moveToolWindow(id, drop.group, drop.before);
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  const onKey = (ev: globalThis.KeyboardEvent) => {
    if (ev.key !== "Escape" || !ghost) return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(false);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
}

function StripeBadge({ useBadge }: { useBadge: () => number | string | null }) {
  const value = useBadge();
  if (value === null || value === 0 || value === "") return null;
  return <span className={styles.badge}>{typeof value === "number" && value > 99 ? "99+" : value}</span>;
}

function StripeButton({
  tw,
  active,
  focused,
  side,
  showName,
}: {
  tw: ToolWindowContribution;
  active: boolean;
  focused: boolean;
  side: "left" | "right";
  showName: boolean;
}) {
  const shortcut = shortcutLabel(`toolwindow.${tw.id}`);
  const dragged = useStripeDrag((s) => s.id === tw.id);
  return (
    <button
      type="button"
      className={clsx(
        styles.stripeButton,
        showName && styles.stripeNamed,
        active && styles.stripeActive,
        active && focused && styles.stripeFocused,
        side === "right" && styles.stripeRight,
        dragged && styles.stripeDragged,
      )}
      aria-label={tx(tw.title)}
      aria-pressed={active}
      aria-keyshortcuts={shortcut}
      data-stripe-button={tw.id}
      onPointerDown={(e) => startStripeDrag(e, tw.id)}
      onClick={() => {
        if (!dragEnded) toggleToolWindow(tw.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e, stripeButtonMenu(tw, showName));
      }}
      {...tooltipAttrs(tw.title, shortcut)}
    >
      <span className={styles.stripeIcon}>
        <Icon name={tw.icon} size={18} />
        {tw.useBadge && <StripeBadge useBadge={tw.useBadge} />}
      </span>
      {showName && (
        <span className={clsx(styles.stripeLabel, !/\s/.test(tw.title) && styles.stripeLabelWord)} aria-hidden="true">
          <T>{tw.title}</T>
        </span>
      )}
    </button>
  );
}

/** Stripe "…": tool windows without a stripe button; opening one adds its button (IDEA). */
function StripeMore({ windows }: { windows: ToolWindowContribution[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const items = useMemo<MenuItem[]>(
    () =>
      [...windows]
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((w) => ({
          id: w.id,
          label: w.title,
          icon: w.icon,
          shortcut: shortcutLabel(`toolwindow.${w.id}`),
          run: () => showToolWindow(w.id, true),
        })),
    [windows],
  );
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={clsx(styles.stripeButton, styles.stripeMore)}
        aria-label="More Tool Windows"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        {...tooltipAttrs("More Tool Windows")}
      >
        <Icon name="more-horizontal" size={18} />
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref}
        items={items}
        placement="right-start"
        aria-label="Tool windows"
      />
    </>
  );
}

function onStripeKeyDown(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
  const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : i + (e.key === "ArrowDown" ? 1 : -1);
  buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
  e.preventDefault();
}

export function ToolWindowStripe({
  side,
  windows,
  visible,
  showNames = true,
  buttonWidth,
}: {
  side: "left" | "right";
  windows: ToolWindowContribution[];
  visible: Record<ToolWindowAnchor, string | null>;
  /** Tool window names under the icons (IDEA "Show Tool Window Names"). */
  showNames?: boolean;
  /** Button width with names, px. */
  buttonWidth?: number;
}) {
  const isActive = (w: ToolWindowContribution) => visible[w.anchor] === w.id;
  const stripeButtons = useToolWindowLayout((s) => s.stripeButtons);
  const onStripe = windows.filter((w) => hasStripeButton(w, stripeButtons) || isActive(w));
  // Left stripe: left windows on top; bottom-anchored windows in the lower group (IDEA new UI).
  const top = onStripe.filter((w) => stripeGroupOf(w) === `${side}-top`);
  const bottom = onStripe.filter((w) => stripeGroupOf(w) === `${side}-bottom`);
  const moreWindows = windows.filter((w) => !onStripe.includes(w));
  const focused = useToolWindowLayout((s) => s.focused);
  const drop = useStripeDrag((s) => s.drop);

  const indicator = (group: StripeGroup, before: string | null) =>
    drop && drop.group === group && drop.before === before ? (
      <div className={styles.stripeDrop} aria-hidden="true" />
    ) : null;
  const renderGroup = (group: StripeGroup, list: ToolWindowContribution[]) => (
    <>
      {list.map((w) => (
        <div key={w.id} className={styles.stripeSlot}>
          {indicator(group, w.id)}
          <StripeButton tw={w} active={isActive(w)} focused={focused === w.id} side={side} showName={showNames} />
        </div>
      ))}
      <div className={styles.stripeSlot}>{indicator(group, null)}</div>
    </>
  );

  return (
    <nav
      aria-label={side === "left" ? "Tool windows" : "Right tool windows"}
      role="toolbar"
      aria-orientation="vertical"
      data-stripe-side={side}
      style={buttonWidth ? ({ "--stripe-button-w": `${buttonWidth}px` } as CSSProperties) : undefined}
      className={clsx(
        styles.stripe,
        showNames && styles.stripeWithNames,
        side === "right" ? styles.stripeSideRight : styles.stripeSideLeft,
      )}
      onKeyDown={onStripeKeyDown}
    >
      {renderGroup(`${side}-top`, top)}
      {side === "left" && <StripeMore windows={moreWindows} />}
      <div className={styles.stripeSpacer} data-stripe-spacer="" />
      {renderGroup(`${side}-bottom`, bottom)}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Panels

const NO_ITEMS: MenuItem[] = [];
const staticMenus = new WeakMap<MenuItem[], (id: string) => MenuItem[]>();
function staticHeaderMenu(items: MenuItem[] | undefined): (id: string) => MenuItem[] {
  if (!items) return () => NO_ITEMS;
  let f = staticMenus.get(items);
  if (!f) staticMenus.set(items, (f = () => items));
  return f;
}

function ToolWindowView({ tw, hidden }: { tw: ToolWindowContribution; hidden: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const focusRequest = useToolWindowLayout((s) => s.focusRequest);
  const maximized = useToolWindowLayout((s) => s.maximized === tw.anchor);
  const [moreOpen, setMoreOpen] = useState(false);
  const [titleOpen, setTitleOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLButtonElement>(null);
  const Content = tw.component;
  const Actions = tw.headerActions;
  const Tabs = tw.headerContent;

  useEffect(() => {
    if (!focusRequest || focusRequest.id !== tw.id || hidden) return;
    const raf = requestAnimationFrame(() => {
      const root = ref.current;
      if (!root) return;
      const body = root.querySelector<HTMLElement>("[data-toolwindow-body]");
      const target =
        body?.querySelector<HTMLElement>("[data-autofocus]") ?? body?.querySelector<HTMLElement>(FOCUSABLE) ?? root;
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [focusRequest, tw.id, hidden]);

  const useHeaderMenu = typeof tw.headerMenu === "function" ? tw.headerMenu : staticHeaderMenu(tw.headerMenu);
  const own = useHeaderMenu(tw.id);
  const more: MenuItem[] = [
    ...own,
    ...(own.length ? [{ kind: "separator" } as MenuItem] : []),
    moveToMenu(tw),
    {
      label: maximized ? "Restore Size" : "Maximize",
      icon: maximized ? "minimize" : "maximize",
      run: () => toggleMaximizeToolWindow(tw.id),
    },
    { kind: "separator" },
    { label: "Hide", icon: "hide", shortcut: shortcutLabel("toolwindow.hideActive"), run: () => hideToolWindow(tw.id) },
  ];

  return (
    <section
      ref={ref}
      className={styles.window}
      data-toolwindow={tw.id}
      aria-label={tx(tw.title)}
      hidden={hidden}
      tabIndex={-1}
    >
      <header
        className={clsx(styles.header, Tabs && styles.headerTabbed)}
        onDoubleClick={(e) => e.target === e.currentTarget && toggleMaximizeToolWindow(tw.id)}
      >
        {Tabs && tw.tabsReplaceTitle ? null : own.length > 0 ? (
          <>
            <button
              ref={titleRef}
              type="button"
              className={styles.titleButton}
              aria-haspopup="menu"
              aria-expanded={titleOpen}
              onClick={() => setTitleOpen((v) => !v)}
            >
              <span className={styles.title}>
                <T>{tw.title}</T>
              </span>
              <Icon name="chevron-down" size={12} className={styles.titleChevron} />
            </button>
            <Menu
              open={titleOpen}
              onClose={() => setTitleOpen(false)}
              anchor={titleRef}
              items={own}
              aria-label={`${tx(tw.title)} view options`}
            />
          </>
        ) : (
          <span className={clsx(styles.title, styles.titlePlain)}>
            <T>{tw.title}</T>
          </span>
        )}
        {Tabs && (
          <div className={clsx(styles.headerContent, tw.tabsReplaceTitle && styles.headerContentOnly)}>
            <Tabs id={tw.id} />
          </div>
        )}
        <div className={styles.headerSpacer} />
        <div className={styles.headerActions}>
          {Actions && <Actions id={tw.id} />}
          <IconButton
            ref={moreRef}
            icon="more"
            title="Options"
            size="small"
            iconSize={16}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          />
          <IconButton
            icon="minus"
            title="Hide"
            shortcut={shortcutLabel("toolwindow.hideActive")}
            size="small"
            iconSize={16}
            onClick={() => hideToolWindow(tw.id)}
          />
        </div>
        <Menu
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          anchor={moreRef}
          items={more}
          placement="bottom-end"
          aria-label={`${tx(tw.title)} options`}
        />
      </header>
      <div className={styles.body} data-toolwindow-body="">
        <Content id={tw.id} />
      </div>
    </section>
  );
}

function AnchorPanel({
  anchor,
  windows,
  visibleId,
}: {
  anchor: ToolWindowAnchor;
  windows: ToolWindowContribution[];
  visibleId: string | null;
}) {
  const mounted = useToolWindowLayout((s) => s.mounted);
  const list = windows.filter((w) => w.anchor === anchor && (mounted.has(w.id) || w.id === visibleId));
  return (
    <div className={clsx(styles.island, styles.anchor)} data-anchor={anchor}>
      {list.map((w) => (
        <ToolWindowView key={w.id} tw={w} hidden={w.id !== visibleId} />
      ))}
    </div>
  );
}

const MIN: Record<ToolWindowAnchor, number> = { left: 140, right: 160, bottom: 90 };
const MAXIMIZED: Record<ToolWindowAnchor, string> = { left: "82%", right: "82%", bottom: "88%" };
/** The editor keeps at least this much room when a tool window is resized (see the grid template). */
const EDITOR_MIN = { width: 200, height: 60 };
const KEY_STEP = 10;

/** Writes the grid's track variables from the store; the grid itself squeezes tracks when the window is small. */
function syncTracks(grid: HTMLElement, visible: Record<ToolWindowAnchor, string | null>) {
  const s = useToolWindowLayout.getState();
  for (const a of ["left", "right", "bottom"] as const) {
    const size = !visible[a] ? "0px" : s.maximized === a ? MAXIMIZED[a] : `${s.sizes[a]}px`;
    grid.style.setProperty(`--tw-${a}`, size);
    grid.style.setProperty(`--gap-${a}`, visible[a] ? "var(--island-gap)" : "0px");
  }
}

/**
 * Resize handle in the gap next to an anchor's island. Moves only a CSS variable
 * while dragging; the remembered size is stored on release.
 */
function GapHandle({
  anchor,
  visibleId,
  gridRef,
  editorRef,
  sync,
}: {
  anchor: ToolWindowAnchor;
  visibleId: string | null;
  gridRef: RefObject<HTMLDivElement | null>;
  editorRef: RefObject<HTMLDivElement | null>;
  sync: () => void;
}) {
  const vertical = anchor !== "bottom";
  const sign = anchor === "left" ? 1 : -1;
  const measure = () => {
    const island = gridRef.current?.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`);
    const editor = editorRef.current;
    if (!island || !editor) return null;
    const size = vertical ? island.offsetWidth : island.offsetHeight;
    const spare = vertical ? editor.offsetWidth - EDITOR_MIN.width : editor.offsetHeight - EDITOR_MIN.height;
    return { size, max: size + Math.max(0, spare) };
  };
  const clamp = (raw: number, max: number) => Math.min(max, Math.max(MIN[anchor], raw));
  const commit = (px: number) => {
    const s = useToolWindowLayout.getState();
    if (visibleId && s.maximized === anchor) toggleMaximizeToolWindow(visibleId);
    setToolWindowSize(anchor, px);
    sync();
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const grid = gridRef.current;
    const m = measure();
    if (e.button !== 0 || !grid || !m || !visibleId) return;
    // No focus (and so no focus ring) or text selection from a mouse drag.
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const origin = vertical ? e.clientX : e.clientY;
    const cursor = document.body.style.cursor;
    document.body.style.cursor = vertical ? "col-resize" : "row-resize";
    let next = m.size;
    const move = (ev: globalThis.PointerEvent) => {
      const raw = m.size + sign * ((vertical ? ev.clientX : ev.clientY) - origin);
      // Dragged past half the minimum: collapse, as IDEA does.
      next = raw < MIN[anchor] / 2 ? 0 : clamp(raw, m.max);
      grid.style.setProperty(`--tw-${anchor}`, `${next}px`);
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      document.body.style.cursor = cursor;
      if (next === 0) hideToolWindow(visibleId);
      else if (next !== m.size) commit(next);
      else sync();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = vertical ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    const dir = keys.indexOf(e.key);
    const m = measure();
    if (dir < 0 || !m) return;
    e.preventDefault();
    commit(clamp(m.size + sign * (dir ? 1 : -1) * KEY_STEP, m.max));
  };

  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={`Resize ${anchor} tool window`}
      tabIndex={0}
      hidden={!visibleId}
      className={styles.gap}
      data-gap={anchor}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

/** Settings › Appearance › Tool Windows (raw settings: the workbench does not depend on the settings feature). */
function useToolWindowAppearance() {
  const a = useProject((s) => s.settings?.appearance);
  const distractionFree = useDistractionFree((s) => s.active);
  return {
    bars: a?.showToolWindowBars !== false && !distractionFree,
    names: a?.showToolWindowNames !== false,
    widescreen: a?.widescreenToolWindows === true,
  };
}

/**
 * The Islands frame below the title bar: stripes on the window background,
 * side tool windows and the editor as rounded islands in one row, bottom
 * tool windows as a full-width island underneath (or, with "Widescreen tool
 * window layout", between the side windows). Resize handles sit in the gaps
 * between islands. A CSS grid does the layout, so a window resize costs no script.
 */
export function ToolWindowLayout({ editor }: { editor: ReactNode }) {
  const windows = useToolWindows();
  const visible = useEffectiveVisible(windows);
  const appearance = useToolWindowAppearance();
  const { bars, widescreen } = appearance;
  const stripes = useStripes();
  const names = (side: StripeSide) => stripes[side].names ?? appearance.names;
  // A change of the setting (here or in Settings) overrides what stripe drags chose.
  const namesSetting = useProject((s) => s.settings?.appearance?.showToolWindowNames);
  const seenNamesSetting = useRef(namesSetting);
  useEffect(() => {
    const seen = seenNamesSetting.current;
    seenNamesSetting.current = namesSetting;
    if (seen !== undefined && seen !== namesSetting) resetStripeNames();
  }, [namesSetting]);
  const frameRef = useRef<HTMLDivElement>(null);
  const stripeHandle = (side: StripeSide) => (
    <StripeHandle
      side={side}
      names={names(side)}
      width={stripes[side].width}
      frameRef={frameRef}
      onPreview={(on) => useStripes.setState({ [side]: { ...stripes[side], names: on } })}
      onCommit={(on, width) => setStripe(side, { width, names: on === appearance.names ? undefined : on })}
    />
  );
  const stripe = (side: StripeSide) => (
    <ToolWindowStripe
      side={side}
      windows={windows}
      visible={visible}
      showNames={names(side)}
      buttonWidth={stripes[side].width}
    />
  );
  const sizes = useToolWindowLayout((s) => s.sizes);
  const maximized = useToolWindowLayout((s) => s.maximized);
  const stripeButtons = useToolWindowLayout((s) => s.stripeButtons);
  const hasRight = windows.some(
    (w) => w.anchor === "right" && (hasStripeButton(w, stripeButtons) || visible.right === w.id),
  );
  // While a stripe button is dragged, an empty right stripe shows as a drop target.
  const dragging = useStripeDrag((s) => !!s.id);
  const rightStripe = bars && (hasRight || dragging);
  const gridRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const sync = () => {
    if (gridRef.current) syncTracks(gridRef.current, visible);
  };
  useLayoutEffect(sync, [visible, sizes, maximized]);

  const gap = (anchor: ToolWindowAnchor) => (
    <GapHandle anchor={anchor} visibleId={visible[anchor]} gridRef={gridRef} editorRef={editorRef} sync={sync} />
  );
  return (
    <div
      ref={frameRef}
      className={clsx(styles.frame, !rightStripe && styles.frameNoRight, !bars && styles.frameNoLeft)}
    >
      {bars && stripe("left")}
      {bars && stripeHandle("left")}
      <div ref={gridRef} className={clsx(styles.grid, widescreen && styles.widescreen)}>
        <AnchorPanel anchor="left" windows={windows} visibleId={visible.left} />
        {gap("left")}
        <div ref={editorRef} className={clsx(styles.island, styles.editorIsland)}>
          {editor}
        </div>
        {gap("right")}
        <AnchorPanel anchor="right" windows={windows} visibleId={visible.right} />
        {gap("bottom")}
        <AnchorPanel anchor="bottom" windows={windows} visibleId={visible.bottom} />
      </div>
      {rightStripe && stripeHandle("right")}
      {rightStripe && stripe("right")}
    </div>
  );
}
