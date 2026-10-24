import { useEffect, useState } from "react";
import { useTxTemplate } from "@/platform/i18n";
import { EmptyState, IconButton, Toast, T } from "@/ui";
import {
  BALLOON_TIMEOUT,
  clearNotifications,
  dismissBalloon,
  markAllNotificationsRead,
  removeNotification,
  useNotifications,
  type IdeNotification,
} from "./notificationStore";
import { useToolWindowLayout } from "./toolwindows/store";
import styles from "./Notifications.module.css";

const MAX_BALLOONS = 3;

function timeLabel(t: number) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function Balloon({ n }: { n: IdeNotification }) {
  const [hover, setHover] = useState(false);
  const txt = useTxTemplate();
  useEffect(() => {
    const ms = BALLOON_TIMEOUT[n.level];
    if (n.sticky || ms === null || hover) return;
    const t = setTimeout(() => dismissBalloon(n.id), ms);
    return () => clearTimeout(t);
  }, [n.id, n.level, n.sticky, hover]);
  return (
    <Toast
      className={styles.balloon}
      level={n.level}
      title={txt(n.title)}
      body={n.body}
      actions={n.actions?.map((a) => ({
        label: txt(a.label),
        run: () => {
          dismissBalloon(n.id);
          a.run();
        },
      }))}
      onClose={() => dismissBalloon(n.id)}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    />
  );
}

/** Bottom-right balloon stack (newest at the bottom); hidden while the Notifications tool window is open. */
export function Balloons() {
  const items = useNotifications((s) => s.items);
  const listOpen = useListVisible();
  const balloons = items
    .filter((n) => n.balloon)
    .slice(0, MAX_BALLOONS)
    .reverse();
  if (listOpen || !balloons.length) return null;
  return (
    <div className={styles.stack} aria-live="polite">
      {balloons.map((n) => (
        <Balloon key={n.id} n={n} />
      ))}
    </div>
  );
}

export const NOTIFICATIONS_TOOL_WINDOW = "notifications";

function useListVisible() {
  return useToolWindowLayout((s) => Object.values(s.visible).includes(NOTIFICATIONS_TOOL_WINDOW));
}

/** The Notifications tool window (right stripe, as in IDEA): history, newest first. */
export function NotificationsToolWindow() {
  const txt = useTxTemplate();
  const all = useNotifications((s) => s.items);
  const items = all.filter((n) => n.logged);
  const visible = useListVisible();
  const unread = all.some((n) => !n.read || n.balloon);
  useEffect(() => {
    if (visible && unread) markAllNotificationsRead();
  }, [visible, unread]);
  return (
    <div className={styles.list} data-autofocus="" tabIndex={-1}>
      {items.length === 0 ? (
        <EmptyState icon="bell">
          <T>No notifications</T>
        </EmptyState>
      ) : (
        items.map((n) => (
          <Toast
            key={n.id}
            className={styles.entry}
            level={n.level}
            title={txt(n.title)}
            body={n.body}
            meta={timeLabel(n.time)}
            actions={n.actions?.map((a) => ({ ...a, label: txt(a.label) }))}
            onClose={() => removeNotification(n.id)}
          />
        ))
      )}
    </div>
  );
}

export function NotificationsHeaderActions() {
  const count = useNotifications((s) => s.items.filter((n) => n.logged).length);
  return (
    <IconButton
      icon="trash"
      title="Clear All"
      size="small"
      iconSize={16}
      disabled={!count}
      onClick={clearNotifications}
    />
  );
}

/** Unread count on the Notifications stripe button. */
export function useUnreadNotifications(): number {
  return useNotifications((s) => s.items.filter((n) => !n.read && n.logged).length);
}
