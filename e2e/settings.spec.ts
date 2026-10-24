import { expect, test } from "./fixtures";

test("⌘, opens Settings with the page tree; Escape closes", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  for (const name of ["Appearance & Behavior", "Keymap", "Editor", "Plugins", "Version Control"]) {
    await expect(dialog.getByRole("treeitem", { name, exact: true })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("Language Servers page installs a tool with progress (in-memory installer)", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  // The page tree is virtualized; search brings the page into view.
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("Language Servers");
  await dialog.getByRole("treeitem", { name: "Language Servers", exact: true }).click();
  const list = dialog.getByRole("list", { name: /language servers/i });
  await expect(list).toBeVisible();

  const row = list.locator('[data-tool="gopls"]');
  await expect(row.getByRole("status")).toHaveAccessibleName("Missing");
  await row.click();
  const details = dialog.locator('div[aria-label="gopls details"]');
  await details.getByRole("button", { name: "Install gopls" }).click();
  await expect(details.getByRole("progressbar", { name: "Installing gopls" })).toBeVisible();
  await expect(row.getByRole("status")).toHaveAccessibleName("Installed");
  await expect(details).toContainText("1.0.0");
  await expect(details.getByRole("button", { name: "Uninstall", exact: true })).toBeVisible();

  // Tools without an installer explain how to get them.
  await list.locator('[data-tool="solargraph"]').click();
  const solargraph = dialog.locator('div[aria-label="solargraph details"]');
  await expect(solargraph).toContainText("gem install solargraph");
});
