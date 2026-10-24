/**
 * Version control (Git) feature: status decorations, title bar branch widget,
 * editor change markers / annotations, Commit and Git tool windows, diff,
 * merge and Local History editors, remote operations.
 */
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import { editorsFor, registerEditorContribution } from "@/editor/api";
import {
  notifications,
  registerEditorKind,
  registerMenuGroup,
  registerOverlay,
  registerTitleItem,
  registerToolWindow,
} from "@/workbench/contributions";
import { executeAction } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { lazyComponent } from "@/ui";
import { registerVcsActions } from "./actions";
import { installChangelists } from "./changelists";
import { registerHistoryActions, trackOperationContext } from "./historyActions";
import { controlLabel, controlOperation, inProgress } from "./operations";
import { annotationsShown, blameSlot } from "./blame";
import { BranchWidget, useBranchesPopup } from "./BranchWidget";
import { showConflictsDialog } from "./conflictsUi";
import { registerCompareActions } from "./compare";
import { DIFF_KIND, diffTitle, type DiffData } from "./diffInput";
import { VcsDialogHost } from "./dialogs";
import { changeMarkers } from "./gutter";
import { installHunkPopup } from "./HunkPopup";
import { LOCAL_HISTORY_KIND } from "./localHistoryKind";
import { registerLocalHistoryActions } from "./localHistoryActions";
import { MERGE_KIND, type MergeData } from "./mergeKind";
import { baseName } from "./model";
import { installDiagnosticsTracking } from "./commitChecks";
import { installPreparedMessage, useCommit } from "./commitStore";
import { installFileConfirmations } from "./confirmations";
import { installIncomingCheck } from "./incoming";
import { installGitLog } from "./logStore";
import { installVcsStore, onConflictsAppeared, onConflictsCleared, useVcs } from "./store";

function trackTitleItem(): () => void {
  let dispose: (() => void) | null = null;
  const sync = (available: boolean) => {
    if (available && !dispose) {
      dispose = registerTitleItem({ id: "vcs.branch", align: "left", priority: 10, component: BranchWidget });
    } else if (!available && dispose) {
      dispose();
      dispose = null;
      useBranchesPopup.setState({ open: false });
    }
  };
  sync(useVcs.getState().available);
  const unsub = useVcs.subscribe((s, p) => {
    if (s.available !== p.available) sync(s.available);
  });
  return () => {
    unsub();
    dispose?.();
  };
}

export function activate(): () => void {
  onConflictsAppeared((files) =>
    notifications().notify({
      group: "vcs",
      level: "warning",
      key: "vcs.conflicts",
      title: "Merge conflicts",
      body: `${files.length} file${files.length === 1 ? " has" : "s have"} conflicts: ${files
        .slice(0, 3)
        .map((f) => baseName(f.path))
        .join(", ")}${files.length > 3 ? "…" : ""}`,
      sticky: true,
      actions: [{ label: "Resolve…", run: showConflictsDialog }],
    }),
  );

  onConflictsCleared(() => {
    notifications().expire?.("vcs.conflicts");
    // As IDEA does once the last conflict is resolved: offer to continue the stopped operation.
    const op = inProgress();
    if (op)
      notifications().notify({
        group: "vcs",
        level: "info",
        key: "vcs.conflicts",
        title: "All conflicts resolved",
        sticky: true,
        actions: [
          op === "merge"
            ? { label: "Commit…", run: () => void executeAction("vcs.commit") }
            : { label: controlLabel(op, "continue"), run: () => void controlOperation("continue", op) },
          { label: controlLabel(op, "abort"), run: () => void controlOperation("abort", op) },
        ],
      });
  });

  useCommit.setState({ signOff: workflowSettings().vcs.git.signOff });
  const disposers = [
    installVcsStore(),
    installGitLog(),
    installDiagnosticsTracking(),
    installPreparedMessage(),
    installIncomingCheck(),
    installFileConfirmations(),
    // Settings › Git › Sign-off commit: the default of Commit Options › Sign-off Commit.
    onWorkflowSettingsChange(
      (w) => w.vcs.git.signOff,
      (signOff) => useCommit.setState({ signOff }),
    ),
    registerVcsActions(),
    registerHistoryActions(),
    registerLocalHistoryActions(),
    installChangelists(),
    trackOperationContext(),
    registerCompareActions(),
    trackTitleItem(),
    installHunkPopup(),
    registerOverlay({ id: "vcs.dialogs", component: VcsDialogHost }),
    registerToolWindow({
      id: "commit",
      title: "Commit",
      icon: "toolwindow-commit",
      anchor: "left",
      order: 1,
      component: lazyComponent(() => import("./CommitView").then((m) => m.CommitToolWindow)),
      headerContent: lazyComponent(() => import("./CommitView").then((m) => m.CommitTabs)),
      tabsReplaceTitle: true,
      useBadge: () => {
        const n = useVcs((s) => s.status.length);
        return n || null;
      },
    }),
    registerToolWindow({
      id: "git",
      title: "Git",
      icon: "toolwindow-git",
      anchor: "bottom",
      order: 5,
      component: lazyComponent(() => import("./GitLog").then((m) => m.GitToolWindow)),
      headerContent: lazyComponent(() => import("./GitLog").then((m) => m.GitTabs)),
    }),
    registerEditorKind({
      kind: DIFF_KIND,
      component: lazyComponent(() => import("./DiffEditor").then((m) => m.DiffEditor)),
      title: (input) => diffTitle(input.data as DiffData),
      icon: () => "diff",
    }),
    registerEditorKind({
      kind: MERGE_KIND,
      component: lazyComponent(() => import("./MergeEditor").then((m) => m.MergeEditor)),
      title: (input) => `Merge: ${baseName((input.data as MergeData).path)}`,
      icon: () => "branch",
    }),
    registerEditorKind({
      kind: LOCAL_HISTORY_KIND,
      component: lazyComponent(() => import("./LocalHistory").then((m) => m.LocalHistoryEditor)),
      title: (input) => `Local History: ${baseName((input.data as { path: string }).path)}`,
      icon: () => "clock",
    }),
    registerEditorContribution({
      id: "vcs.changeMarkers",
      order: 60,
      extensions: (ctx) => [changeMarkers(ctx), blameSlot()],
    }),
    registerMenuGroup({
      id: "vcs.gutter",
      menus: ["editorGutter"],
      order: 10,
      items: (_menu, { paths: [path] }) => {
        if (!path || !getContext().vcsAvailable) return [];
        const shown = editorsFor(path).some((h) => annotationsShown(h.view));
        return [
          {
            label: shown ? "Close Annotations" : "Annotate with Git Blame",
            run: () => void executeAction("vcs.annotate", path),
          },
        ];
      },
    }),
  ];
  return () => {
    onConflictsAppeared(() => undefined);
    disposers.reverse().forEach((d) => d());
  };
}
