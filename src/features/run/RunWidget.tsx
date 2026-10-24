import { useRef, useState } from "react";
import clsx from "clsx";
import { BarButton, Icon, IconButton, Menu, type MenuItem } from "@/ui";
import { executeAction } from "@/platform/actions";
import { useContextKeys } from "@/platform/context";
import { useTx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
import { runExecutors, useRunExecutors } from "@/workbench/contributions";
import { configIcon } from "./configs";
import { rerunSession, stopSession, useRun } from "./store";
import styles from "./Run.module.css";

/** Title bar: configuration chooser, Run / Debug, and Rerun / Stop while running. */
export function RunWidget() {
  const tx = useTx();
  const configs = useRun((s) => s.configs);
  const selectedId = useRun((s) => s.selectedId);
  const sessions = useRun((s) => s.sessions);
  const chooserOpen = useRun((s) => s.chooserOpen);
  const selected = configs.find((c) => c.id === selectedId);
  const running = sessions.filter((s) => s.status === "running" || s.status === "starting");
  const runningSelected = running.find((s) => s.config.id === selectedId) ?? null;
  const target = runningSelected ?? running[running.length - 1] ?? null;
  // Debug sessions belong to the debugger feature; like IDEA the widget offers their Rerun / Stop.
  const debugging = useContextKeys((c) => !!c.debugSessionActive);
  const canRerunDebug = useContextKeys((c) => !!c.debugCanRerun);
  const debugPaused = useContextKeys((c) => !!c.debugSessionPaused);
  const active = !!runningSelected || debugging;
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const executors = useRunExecutors((s) => s.executors);
  // IDEA: the selected configuration's other executors (Run with Coverage, Profile) come first.
  const executorItems: MenuItem[] = selected
    ? runExecutors(executors)
        .filter((e) => e.supports(selected))
        .map((e) => ({ kind: "action", action: e.action, label: e.label(selected.name), icon: e.icon }))
    : [];
  const moreItems: MenuItem[] = [
    ...executorItems,
    ...(executorItems.length ? [{ kind: "separator" } as const] : []),
    { kind: "action", action: "run.runContext" },
    { kind: "action", action: "run.debugContext" },
    { kind: "separator" },
    { kind: "action", action: "run.editConfigs" },
    { kind: "action", action: "run.reloadConfigs" },
  ];

  return (
    <div className={styles.widget}>
      <BarButton
        variant="title"
        className={styles.widgetChooser}
        tooltip={tx("Run/Debug Configurations")}
        shortcut={shortcutLabel("run.chooseConfig")}
        aria-haspopup="listbox"
        aria-expanded={chooserOpen}
        data-run-chooser=""
        onClick={() => void executeAction(selected || configs.length ? "run.chooseConfig" : "run.editConfigs")}
      >
        {selected && (
          // IDEA: the configuration's type icon, with a status dot on its top-right corner while active.
          <span className={styles.widgetConfigIcon}>
            <Icon name={configIcon(selected)} size={16} />
            {active && (
              <span className={styles.widgetStatusDot} aria-label={debugging ? "Debugging" : "Running"} role="img" />
            )}
          </span>
        )}
        <span className={styles.widgetName}>
          {selected?.name ?? tx(configs.length ? "Select Configuration" : "Add Configuration…")}
        </span>
        <Icon name="chevron-down" size={14} className={styles.widgetChevron} />
      </BarButton>
      <span className={styles.widgetButtons}>
        {target ? (
          <>
            <IconButton
              icon="rerun-filled"
              size="large"
              iconSize={16}
              className={clsx(styles.widgetButton, styles.widgetFilled, styles.widgetFilledRun)}
              title={`Rerun '${target.config.name}'`}
              shortcut={shortcutLabel("run.run")}
              onClick={() => rerunSession(target.id)}
            />
            <IconButton
              icon="stop-filled"
              size="large"
              iconSize={16}
              className={clsx(styles.widgetButton, styles.widgetFilled, styles.widgetFilledStop)}
              title={running.length > 1 ? `Stop (${running.length} running)` : `Stop '${target.config.name}'`}
              shortcut={shortcutLabel("run.stop")}
              onClick={() => (running.length > 1 ? void executeAction("run.stop") : void stopSession(target.id))}
            />
          </>
        ) : debugging ? (
          // IDEA while debugging: Resume (when paused), Rerun Debug and Stop as filled buttons.
          <>
            {debugPaused && (
              <IconButton
                icon="resume"
                size="large"
                iconSize={18}
                className={styles.widgetButton}
                title="Resume Program"
                shortcut={shortcutLabel("debug.resume")}
                onClick={() => void executeAction("debug.resume")}
              />
            )}
            <IconButton
              icon="restart-debug-filled"
              size="large"
              iconSize={16}
              className={clsx(styles.widgetButton, styles.widgetFilled, styles.widgetFilledRun)}
              title="Rerun Debug Session"
              shortcut={shortcutLabel("debug.rerun")}
              disabled={!canRerunDebug}
              onClick={() => void executeAction("debug.rerun")}
            />
            <IconButton
              icon="stop-filled"
              size="large"
              iconSize={16}
              className={clsx(styles.widgetButton, styles.widgetFilled, styles.widgetFilledStop)}
              title="Stop Debug Session"
              shortcut={shortcutLabel("debug.stop")}
              onClick={() => void executeAction("debug.stop")}
            />
          </>
        ) : (
          <>
            <IconButton
              icon="run"
              size="large"
              iconSize={18}
              className={clsx(styles.widgetButton, styles.widgetRun)}
              title={selected ? `Run '${selected.name}'` : "Run"}
              shortcut={shortcutLabel("run.run")}
              disabled={!selected}
              onClick={() => void executeAction("run.run")}
            />
            <IconButton
              icon="debug"
              size="large"
              iconSize={18}
              className={styles.widgetButton}
              title={selected ? `Debug '${selected.name}'` : "Debug"}
              shortcut={shortcutLabel("run.debug")}
              disabled={!selected}
              onClick={() => void executeAction("run.debug")}
            />
          </>
        )}
        <IconButton
          ref={moreRef}
          icon="more"
          size="large"
          iconSize={18}
          className={styles.widgetButton}
          title="More Actions"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
        />
        <Menu
          open={moreOpen}
          anchor={moreRef}
          items={moreItems}
          placement="bottom-end"
          onClose={() => setMoreOpen(false)}
        />
      </span>
    </div>
  );
}
