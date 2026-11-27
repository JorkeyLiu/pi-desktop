import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const menuPath = join(root, "apps/desktop/src/components/ContextMenu.tsx");
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixture = `
import { createRoot } from "react-dom/client";
import { useContextMenu, ContextMenu } from __MENU_PATH__;

const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const until = async (probe, label) => {
  const end = Date.now() + 5000;
  while (!probe()) {
    if (Date.now() > end) throw new Error("timed out: " + label);
    await frame();
  }
};
const isOpen = () => document.querySelector(".context-menu.is-open") !== null;
const tabMenu = { label: "Tab actions", items: [{ id: "close", label: "Close", onSelect: () => {} }] };

function Probe() {
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();
  return (<>
    <div id="thread" style={{ height: "120px", overflow: "auto" }}>
      <div style={{ height: "800px" }}>
        <div id="tab-label" onContextMenu={(event) => openContextMenu(event, tabMenu)}>Tab</div>
      </div>
    </div>
    <ContextMenu state={contextMenu} onClose={closeContextMenu} />
  </>);
}

createRoot(document.getElementById("root")).render(<Probe />);

const rightClickTab = () => document.getElementById("tab-label").dispatchEvent(
  new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 30 }),
);

window.runMenuProbe = async () => {
  const steps = {};
  rightClickTab();
  await until(isOpen, "menu opens");
  steps.opened = true;
  const thread = document.getElementById("thread");
  thread.scrollTop = 200;
  thread.dispatchEvent(new Event("scroll"));
  await frame(); await frame();
  steps.scrollKeepsOpen = isOpen();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await until(() => !isOpen(), "escape closes");
  steps.escapeCloses = true;
  rightClickTab();
  await until(isOpen, "menu reopens");
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  await until(() => !isOpen(), "outside press closes");
  steps.outsidePressCloses = true;
  steps.passed = steps.opened && steps.scrollKeepsOpen && steps.escapeCloses && steps.outsidePressCloses;
  return steps;
};
`;

const main = `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const steps = await win.webContents.executeJavaScript("window.runMenuProbe()");
    console.log("MENU_PROBE " + JSON.stringify(steps));
    app.exit(steps && steps.passed ? 0 : 1);
  } catch (error) { console.error((error && error.stack) || error); app.exit(1); }
});
`;

test("an open tab menu survives an outside scroll and still closes on demand", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "context-menu-"));
  try {
    await build({
      stdin: { contents: fixture.replaceAll("__MENU_PATH__", JSON.stringify(menuPath)), resolveDir: root, loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), main);
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8"); stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split("\n").find((entry) => entry.startsWith("MENU_PROBE "));
    const steps = JSON.parse(line.slice("MENU_PROBE ".length));
    assert.equal(steps.scrollKeepsOpen, true, "outside scroll closed the menu");
    assert.equal(steps.escapeCloses, true, "Escape no longer closes the menu");
    assert.equal(steps.outsidePressCloses, true, "outside press no longer closes the menu");
  } finally { await rm(temp, { recursive: true, force: true }); }
});
