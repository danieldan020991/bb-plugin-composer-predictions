import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mountGhostDecorations, refreshGhost, registerGhost } from "../lib/ghost.ts";

function fixture() {
  const dom = new JSDOM(`<!doctype html><html><head></head><body><div data-promptbox-shell><span id="bridge"></span><form data-promptbox><div data-promptbox-editor-content><div contenteditable="true"><p class="is-editor-empty"><br></p></div></div></form></div></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  const editor = doc.querySelector<HTMLElement>("[contenteditable]")!;
  const anchor = doc.getElementById("bridge")!;
  let accepted = 0; let dismissed = 0; let eligible = true; let generationId = "one";
  const disposeScript = mountGhostDecorations(doc);
  const disposeBinding = registerGhost({ anchor, snapshot: () => ({ suggestion: "Show me the diff", generationId, eligible, compact: false }), accept: () => { accepted++; editor.textContent = "Show me the diff"; return true; }, dismiss: () => { dismissed++; eligible = false; } });
  const press = (key: string, options: KeyboardEventInit = {}) => {
    const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
    editor.dispatchEvent(event); return event;
  };
  return { dom, doc, editor, anchor, press, accepted: () => accepted, dismissed: () => dismissed, setEligible: (value: boolean) => { eligible = value; refreshGhost(); }, setGeneration: (value: string) => { generationId = value; refreshGhost(); }, cleanup: () => { disposeBinding(); disposeScript(); dom.window.close(); } };
}
test("ghost is outside the editor; only plain Tab accepts, never submits", () => {
  const f = fixture(); let submitted = 0;
  f.doc.querySelector("form")!.addEventListener("submit", () => submitted++);
  assert.equal(f.editor.textContent, "");
  assert.equal(f.editor.querySelector("[data-composer-prediction-ghost]"), null);
  for (const options of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) assert.equal(f.press("Tab", options).defaultPrevented, false);
  assert.equal(f.press("Enter").defaultPrevented, false);
  assert.equal(f.accepted(), 0);
  assert.equal(f.press("Tab").defaultPrevented, true);
  assert.equal(f.accepted(), 1); assert.equal(submitted, 0); assert.equal(f.editor.textContent, "Show me the diff");
  assert.equal(f.press("Tab").defaultPrevented, false);
  f.cleanup();
});
test("typing and IME dismiss immediately; a nonempty or unavailable composer cannot accept", () => {
  for (const event of ["beforeinput", "paste", "compositionstart"]) {
    const f = fixture(); f.editor.dispatchEvent(new f.dom.window.Event(event, { bubbles: true }));
    assert.equal(f.doc.querySelector<HTMLElement>("[data-composer-prediction-ghost]")!.hidden, true);
    assert.equal(f.press("Tab").defaultPrevented, false); assert.equal(f.dismissed(), 1); f.cleanup();
  }
  const f = fixture(); f.editor.textContent = "my own draft"; refreshGhost();
  assert.equal(f.press("Tab").defaultPrevented, false); assert.equal(f.accepted(), 0);
  f.editor.textContent = ""; f.setEligible(false); assert.equal(f.press("Tab").defaultPrevented, false); f.cleanup();
});
test("Escape dismisses without trapping focus and cleanup restores editor styling", () => {
  const f = fixture(); assert.ok(f.editor.hasAttribute("data-composer-prediction-active"));
  assert.equal(f.press("Escape").defaultPrevented, false); assert.equal(f.dismissed(), 1);
  f.cleanup();
  assert.equal(f.editor.hasAttribute("data-composer-prediction-active"), false);
  assert.equal(f.doc.querySelector("[data-composer-prediction-ghost]"), null);
});
test("bridge targets only its own composer, regardless of pane order", () => {
  const f = fixture();
  const other = f.doc.createElement("div"); other.setAttribute("data-promptbox-shell", "");
  other.innerHTML = '<form data-promptbox><div data-promptbox-editor-content><div contenteditable="true"></div></div></form>';
  f.doc.body.prepend(other); refreshGhost();
  const editor = other.querySelector("[contenteditable]")!;
  const event = new f.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }); editor.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false); assert.equal(f.accepted(), 0);
  assert.equal(other.querySelector("[data-composer-prediction-ghost]"), null); f.cleanup();
});
test("ambiguous or moved composer shells release their old overlay and Tab handler", () => {
  const f = fixture();
  const duplicate = f.editor.cloneNode(true);
  f.editor.parentElement!.append(duplicate); refreshGhost();
  assert.equal(f.doc.querySelector("[data-composer-prediction-ghost]"), null);
  assert.equal(f.press("Tab").defaultPrevented, false);
  duplicate.parentNode!.removeChild(duplicate); refreshGhost();
  f.doc.body.append(f.anchor); refreshGhost();
  assert.equal(f.doc.querySelector("[data-composer-prediction-ghost]"), null);
  assert.equal(f.press("Tab").defaultPrevented, false); f.cleanup();
});
test("editing while generation is pending still notifies the composer bridge", () => {
  const f = fixture(); f.setEligible(false);
  f.editor.dispatchEvent(new f.dom.window.Event("beforeinput", { bubbles: true }));
  assert.equal(f.dismissed(), 1); f.cleanup();
});
test("read-only and voice-mode transitions hide the ghost without waiting for a React render", async () => {
  for (const mode of ["readonly", "voice"]) {
    const f = fixture();
    if (mode === "readonly") f.editor.setAttribute("contenteditable", "false");
    else f.editor.closest("form")!.setAttribute("data-promptbox-voice-active", "");
    await new Promise(resolve => f.dom.window.requestAnimationFrame(() => f.dom.window.requestAnimationFrame(resolve)));
    assert.equal(f.doc.querySelector<HTMLElement>("[data-composer-prediction-ghost]:not([hidden])"), null);
    assert.equal(f.editor.hasAttribute("data-composer-prediction-active"), false);
    assert.equal(f.press("Tab").defaultPrevented, false); f.cleanup();
  }
});
test("a Tab already handled by the host is not accepted again", () => {
  const f = fixture();
  f.doc.addEventListener("keydown", event => event.preventDefault(), { capture: true });
  f.press("Tab"); assert.equal(f.accepted(), 0); f.cleanup();
});
test("explicit regeneration can show the same words after a dismissal", () => {
  const f = fixture(); f.press("Escape"); f.setEligible(true);
  assert.equal(f.doc.querySelector<HTMLElement>("[data-composer-prediction-ghost]")!.hidden, true);
  f.setGeneration("two");
  assert.equal(f.doc.querySelector<HTMLElement>("[data-composer-prediction-ghost]")!.hidden, false); f.cleanup();
});
test("tapping the Tab key label accepts like Tab (phones have no Tab key), never submits", () => {
  const f = fixture(); let submitted = 0;
  f.doc.querySelector("form")!.addEventListener("submit", () => submitted++);
  const key = f.doc.querySelector<HTMLElement>("[data-composer-prediction-ghost] kbd")!;
  assert.ok(key, "the Tab label exists");
  const overlay = key.closest<HTMLElement>("[data-composer-prediction-ghost]")!;
  assert.ok(overlay.inert !== true && !overlay.hasAttribute("inert"), "an inert overlay swallows the tap");
  const down = new f.dom.window.Event("pointerdown", { bubbles: true, cancelable: true }); key.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true, "pointerdown keeps the editor focus");
  key.dispatchEvent(new f.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(f.accepted(), 1); assert.equal(submitted, 0); assert.equal(f.editor.textContent, "Show me the diff");
  key.dispatchEvent(new f.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(f.accepted(), 1, "a hidden ghost does not accept again");
  f.cleanup();
});
