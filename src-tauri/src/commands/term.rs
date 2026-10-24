use crate::state::AppState;
use ide_core::{IdeResult, TerminalId};
use ide_terminal::{TerminalInfo, TerminalOptions};
use tauri::ipc::Channel;
use tauri::{State, Window};

#[tauri::command]
#[specta::specta]
pub fn term_spawn(
    window: Window,
    state: State<'_, AppState>,
    options: TerminalOptions,
    on_output: Channel<String>,
) -> IdeResult<TerminalInfo> {
    // Python › "Activate virtualenv": typed into the new shell, like PyCharm.
    let activation = state
        .project(window.label())
        .ok()
        .and_then(|p| ide_sdk::apply::terminal_activation(&p.root, &p.settings.effective(), options.shell.as_deref()));
    let info = state.terminals.spawn(
        options,
        state.window_sink(window.label()),
        Box::new(move |chunk| {
            let _ = on_output.send(chunk);
        }),
    )?;
    if let Some(line) = activation {
        let _ = state.terminals.write(info.id, &format!(" {line}\r"));
    }
    Ok(info)
}

#[tauri::command]
#[specta::specta]
pub fn term_write(state: State<'_, AppState>, id: TerminalId, data: String) -> IdeResult<()> {
    state.terminals.write(id, &data)
}

#[tauri::command]
#[specta::specta]
pub fn term_resize(state: State<'_, AppState>, id: TerminalId, cols: u16, rows: u16) -> IdeResult<()> {
    state.terminals.resize(id, cols, rows)
}

#[tauri::command]
#[specta::specta]
pub fn term_kill(state: State<'_, AppState>, id: TerminalId) -> IdeResult<()> {
    state.terminals.kill(id)
}

/// Shell used when Settings › Terminal › Shell path is empty.
#[tauri::command]
#[specta::specta]
pub fn term_default_shell() -> String {
    ide_terminal::default_shell_path()
}

/// Installed shells for the Terminal's "New Predefined Session" menu.
#[tauri::command]
#[specta::specta]
pub fn term_available_shells() -> Vec<String> {
    ide_terminal::available_shells()
}
