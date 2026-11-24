#!/usr/bin/env node
// Real right-button pointer input against the transcript's selected-text menu.
// Synthetic `contextmenu` MouseEvents never run Chromium's press default, so
// they cannot show whether an ordinary right-click fabricates a selection.
// This runner presses the real secondary button through
// `webContents.sendInputEvent` and reads the live selection across the
// pointerdown/mousedown/contextmenu sequence.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const scratchBase = process.env.PI_SCRATCH_DIR || tmpdir();
const temp = await mkdtemp(join(scratchBase, "ctxmenu-right-click-"));
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
await require("esbuild").build({
  entryPoints: [join(root, "scripts/e2e/chat-selection-right-click.tsx")],
  outfile: join(temp, "renderer.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  loader: { ".css": "empty" },
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  alias: {
    react: join(desktop, "node_modules/react"),
    "react-dom": join(desktop, "node_modules/react-dom"),
  },
  nodePaths: [join(desktop, "node_modules")],
});
await writeFile(
  join(temp, "index.html"),
  '<!doctype html><html><body><script src="renderer.js"></script></body></html>',
);
await writeFile(
  join(temp, "driver.cjs"),
  `
const {app,BrowserWindow}=require('electron');
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
app.setPath('userData',require('node:path').join(__dirname,'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const failures=[];
  const check=(ok,label,detail)=>{
    console.log((ok?"ok":"FAIL")+" - "+label+(detail?" "+JSON.stringify(detail):""));
    if(!ok) failures.push(label);
  };
  try {
    const win=new BrowserWindow({show:false,width:900,height:700,webPreferences:{backgroundThrottling:false,sandbox:true,contextIsolation:true}});
    const js=(expression)=>win.webContents.executeJavaScript(expression);
    await win.loadFile(require('node:path').join(__dirname,'index.html'));
    const text=await js('globalThis.chatRightClickProbe.ready()');
    console.log("content: "+JSON.stringify(text));
    const rightClick=async(point)=>{
      await js('globalThis.chatRightClickProbe.clearLog()');
      const before=await js('globalThis.chatRightClickProbe.selection()');
      const x=Math.round(point.x), y=Math.round(point.y);
      win.webContents.sendInputEvent({type:'mouseDown',button:'right',x,y,clickCount:1});
      await sleep(250);
      const afterDown=await js('globalThis.chatRightClickProbe.selection()');
      win.webContents.sendInputEvent({type:'mouseUp',button:'right',x,y,clickCount:1});
      await sleep(400);
      const afterUp=await js('globalThis.chatRightClickProbe.selection()');
      const menu=await js('globalThis.chatRightClickProbe.menu()');
      const items=await js('globalThis.chatRightClickProbe.menuItems()');
      const log=await js('globalThis.chatRightClickProbe.log()');
      return {before,afterDown,afterUp,menu,items,log};
    };

    // Scenario A: no selection anywhere; an ordinary right-click on English
    // prose must not fabricate a selection and must open no menu.
    await js('globalThis.chatRightClickProbe.clearSelection()');
    const englishPoint=await js('globalThis.chatRightClickProbe.englishPoint()');
    const en=await rightClick(englishPoint);
    console.log("A events: "+JSON.stringify(en.log));
    check(en.before.text===""&&en.before.collapsed,"A starts without a selection",en.before);
    check(en.afterUp.text==="","A plain right-click on English leaves no selection",{afterDown:en.afterDown,afterUp:en.afterUp});
    check(!en.menu,"A plain right-click on English opens no menu",{items:en.items,afterUp:en.afterUp});

    // Scenario B: same, on Chinese prose.
    await js('globalThis.chatRightClickProbe.clearSelection()');
    const chinesePoint=await js('globalThis.chatRightClickProbe.chinesePoint()');
    const zh=await rightClick(chinesePoint);
    console.log("B events: "+JSON.stringify(zh.log));
    check(zh.afterUp.text==="","B plain right-click on Chinese leaves no selection",{afterDown:zh.afterDown,afterUp:zh.afterUp});
    check(!zh.menu,"B plain right-click on Chinese opens no menu",{items:zh.items,afterUp:zh.afterUp});

    // Scenario C: an existing selection, right-click inside it, keeps the
    // exact selection and offers Copy and Quote.
    await js('globalThis.chatRightClickProbe.select(0,12)');
    const inside=await js('globalThis.chatRightClickProbe.selectionPoint()');
    const kept=await js('globalThis.chatRightClickProbe.selection()');
    const c=await rightClick(inside);
    console.log("C events: "+JSON.stringify(c.log));
    check(c.menu,"C right-click inside the selection opens the menu",{menu:c.menu,items:c.items});
    check(c.items.join("|")==="Copy|Quote","C menu offers Copy and Quote only",c.items);
    check(c.afterUp.text===kept.text,"C right-click inside keeps the exact selection",{kept:kept.text,after:c.afterUp.text});

    // Scenario D: an existing selection, right-click outside it on the same
    // text node, clears the old selection and opens no menu.
    await js('globalThis.chatRightClickProbe.select(0,5)');
    const far=await js('globalThis.chatRightClickProbe.chinesePoint()');
    const d=await rightClick(far);
    console.log("D events: "+JSON.stringify(d.log));
    check(!d.menu,"D right-click outside the selection opens no menu",{items:d.items,afterUp:d.afterUp});
    check(d.afterUp.text==="","D right-click outside clears the old selection",d.afterUp);

    if(failures.length){ console.log("RESULT FAIL"); app.exit(1); }
    console.log("RESULT PASS");
    app.exit(0);
  } catch(error) { console.error(error); app.exit(1); }
});`,
);
const { electronBinary } = resolveElectronBinary(root);
const result = spawnSync(electronBinary, [join(temp, "driver.cjs")], {
  stdio: "inherit",
  timeout: 120000,
  env: { ...process.env },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
