/** Notification center: balloons + history, backing `NotificationService`. */
import type { ReactNode } from "react";
import { create } from "zustand";
import { onIdeEvent } from "@/platform/ipc";
import { tx, useI18n } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import type { NotificationService } from "./contributions";

export type NotificationLevel = "info" | "warning" | "error";

export interface IdeNotification {
  id: number;
  key?: string;
  level: NotificationLevel;
  title: string;
  body?: ReactNode;
  actions?: Array<{ label: string; run: () => void }>;
  time: number;
  read: boolean;
  /** Currently shown as a balloon. */
  balloon: boolean;
  sticky: boolean;
  group: string;
  /** Listed in the Notifications tool window (the group's "Show in tool window"). */
  logged: boolean;
}

/** Notification groups shown in Settings › Appearance & Behavior › Notifications. */
export const NOTIFICATION_GROUPS: ReadonlyArray<{ id: string; title: string }> = [
  { id: "system", title: "System Messages" },
  { id: "lsp", title: "Language Servers" },
  { id: "vcs", title: "Version Control" },
  { id: "run", title: "Run and Debug" },
  { id: "tools", title: "External Tools" },
  { id: "search", title: "Find in Files" },
  { id: "plugins", title: "Plugins" },
  { id: "updates", title: "IDE Updates" },
];

export type NotificationDisplay = "balloon" | "sticky" | "none";

interface NotificationPrefs {
  balloons: boolean;
  sound: boolean;
  display: NotificationDisplay;
  log: boolean;
}

/** Settings › Notifications for one group (raw settings: the shell does not depend on the settings feature). */
export function notificationPrefs(group: string): NotificationPrefs {
  const n = useProject.getState().settings?.notifications;
  const g = n?.groups?.[group];
  const display = g?.display === "sticky" || g?.display === "none" ? g.display : "balloon";
  return { balloons: n?.balloons !== false, sound: n?.sound === true, display, log: g?.log !== false };
}

function groupOf(n: { group?: string; key?: string }): string {
  if (n.group) return n.group;
  if (n.key?.startsWith("app.update")) return "updates";
  if (n.key?.startsWith("lsp")) return "lsp";
  return "system";
}

let audio: AudioContext | null = null;

/** Short notification chime ("Play sound"). */
function playSound() {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.25);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.25);
  } catch {
    /* no audio output */
  }
}

interface NotificationState {
  items: IdeNotification[];
}

export const useNotifications = create<NotificationState>(() => ({ items: [] }));

export const BALLOON_TIMEOUT: Record<NotificationLevel, number | null> = { info: 6000, warning: 10000, error: null };
const MAX_HISTORY = 200;
let seq = 0;

/** Common notification patterns embed runtime names, so they need lightweight interpolation. */
const NOTIFICATION_PATTERNS: Array<[RegExp, (...groups: string[]) => string]> = [
  [/^(.+?) has unsaved changes$/, (name) => `${name} 有未保存的更改`],
  [/^(.+?) is not installed$/, (name) => `${name} 未安装`],
  [/^Installing (.+)$/, (name) => `正在安装 ${name}`],
  [/^Failed to install (.+)$/, (name) => `安装 ${name} 失败`],
  [/^Uninstalled (.+)$/, (name) => `已卸载 ${name}`],
  [/^Failed to uninstall (.+)$/, (name) => `卸载 ${name} 失败`],
  [/^Installed (.+?) (.+)$/, (name, version) => `已安装 ${name} ${version}`],
  [/^(.+?) installed$/, (name) => `${name} 已安装`],
  [/^(.+?) failed$/, (name) => `${name} 失败`],
  [/^Cannot find usages of '(.+)'$/, (name) => `无法查找 '${name}' 的用法`],
  [/^No usages of '(.+)' found$/, (name) => `未找到 '${name}' 的用法`],
  [/^No coverage data for '(.+)'$/, (name) => `没有 '${name}' 的覆盖率数据`],
  [/^Cannot profile '(.+)'$/, (name) => `无法分析 '${name}'`],
  [/^No profile for '(.+)'$/, (name) => `没有 '${name}' 的分析数据`],
  [/^Stopped after (\d+) matches$/, (count) => `匹配 ${count} 处后停止`],
  [/^(.*) has no tracked branch$/, (branch) => `${branch} 没有跟踪分支`],
  [/^Cannot connect to (.+)$/, (target) => `无法连接到 ${target}`],
  [/^Cannot execute on (.+)$/, (target) => `无法在 ${target} 上执行`],
  [/^Cannot get the DDL of (.+)$/, (name) => `无法获取 ${name} 的 DDL`],
  [/^(\d+) rows exported$/, (count) => `已导出 ${count} 行`],
  [/^Checked out pull request #(.+)$/, (number) => `已检出拉取请求 #${number}`],
  [/^Review submitted on #(.+)$/, (number) => `已在 #${number} 上提交审查`],
  [/^Tests failed: (.+)$/, (detail) => `测试失败：${detail}`],
];

function notificationText(text: string): string {
  const exact = tx(text);
  if (exact !== text) return exact;
  if (!useI18n.getState().locale.startsWith("zh")) return text;
  const match = NOTIFICATION_PATTERNS.map(([pattern, make]) => [text.match(pattern), make] as const).find(
    ([matches]) => matches,
  );
  return match?.[0] ? match[1](...match[0].slice(1)) : text;
}

export function notify(n: Parameters<NotificationService["notify"]>[0]): number {
  const id = ++seq;
  const group = groupOf(n);
  const prefs = notificationPrefs(group);
  const balloon = prefs.balloons && prefs.display !== "none";
  const sticky = prefs.display === "sticky" || (n.sticky ?? BALLOON_TIMEOUT[n.level] === null);
  // Neither shown nor listed: dropped, as IDEA's "No popup" + no log.
  if (!balloon && !prefs.log) return id;
  const item: IdeNotification = {
    id,
    key: n.key,
    level: n.level,
    title: notificationText(n.title),
    body: typeof n.body === "string" ? notificationText(n.body) : n.body,
    actions: n.actions?.map((action) => ({ ...action, label: notificationText(action.label) })),
    time: Date.now(),
    read: false,
    balloon,
    sticky,
    group,
    logged: prefs.log,
  };
  useNotifications.setState((s) => {
    const rest = n.key ? s.items.filter((x) => x.key !== n.key) : s.items;
    return { items: [item, ...rest].slice(0, MAX_HISTORY) };
  });
  if (balloon && prefs.sound) playSound();
  return id;
}

export function dismissBalloon(id: number) {
  useNotifications.setState((s) => ({
    // Unlogged notifications only existed for their balloon.
    items: s.items.flatMap((x) => (x.id !== id ? [x] : x.logged ? [{ ...x, balloon: false }] : [])),
  }));
}

/** Hides the balloon for `key`: the condition it reported no longer holds. */
export function expireNotification(key: string) {
  useNotifications.setState((s) => ({
    items: s.items.flatMap((x) => (x.key !== key || !x.balloon ? [x] : x.logged ? [{ ...x, balloon: false }] : [])),
  }));
}

export function removeNotification(id: number) {
  useNotifications.setState((s) => ({ items: s.items.filter((x) => x.id !== id) }));
}

export function clearNotifications() {
  useNotifications.setState({ items: [] });
}

/** The list was seen: everything is read and no longer shown as a balloon. */
export function markAllNotificationsRead() {
  useNotifications.setState((s) => ({
    items: s.items
      .filter((x) => x.logged)
      .map((x) => (x.read && !x.balloon ? x : { ...x, read: true, balloon: false })),
  }));
}

export const notificationServiceImpl: NotificationService = {
  notify: (n) => void notify(n),
  expire: expireNotification,
};

export function installNotifyEvents(): () => void {
  return onIdeEvent("notify", (e) => void notify({ level: e.level, title: e.title, body: e.body ?? undefined }));
}
