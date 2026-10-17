/** Trusted content-script decoration. Nothing is inserted into the editor document. */
export interface GhostBinding {
  anchor: HTMLElement;
  snapshot(): { suggestion: string | null; generationId: string | null; eligible: boolean; compact: boolean };
  accept(): boolean;
  dismiss(): void;
}
const bindings = new Map<HTMLElement, GhostBinding>();
let refresh = () => {};
export function registerGhost(binding: GhostBinding): () => void {
  bindings.set(binding.anchor, binding); refresh();
  return () => { bindings.delete(binding.anchor); refresh(); };
}
export function refreshGhost() { refresh(); }

export function mountGhostDecorations(doc: Document): () => void {
  const win = doc.defaultView!;
  const style = doc.createElement("style");
  style.textContent = `
    [data-composer-prediction-active] p.is-editor-empty:first-child::before { content: none !important; }
    [data-composer-prediction-ghost] { position:absolute; pointer-events:none; user-select:none; white-space:pre-wrap; overflow:hidden; color:var(--muted-foreground); opacity:.65; z-index:1; }
    [data-composer-prediction-ghost]:not([hidden]) { display:flex; align-items:baseline; }
    [data-composer-prediction-ghost] span { min-width:0; overflow:hidden; display:-webkit-box; -webkit-box-orient:vertical; }
    [data-composer-prediction-ghost] kbd { flex-shrink:0; margin-left:.65em; padding:0 .35em; border:1px solid currentColor; border-radius:4px; font:10px/1.5 ui-monospace,monospace; opacity:.8; white-space:nowrap; }
    /* Fork: the Tab label is a tap target too -- phones have no Tab key. Only the label takes pointers. */
    [data-composer-prediction-ghost] kbd { pointer-events:auto; cursor:pointer; touch-action:manipulation; }
    @media (pointer: coarse) { [data-composer-prediction-ghost] kbd { font-size:13px; padding:.15em .6em; } }
  `;
  doc.head.append(style);
  type Decoration = { editor: HTMLElement; update(): void; dispose(): void };
  const decorations = new Map<HTMLElement, Decoration>();
  let disposed = false;
  let frame: number | null = null;

  function decorate(binding: GhostBinding, editor: HTMLElement): Decoration {
    const parent = editor.parentElement!;
    const originalPosition = parent.style.position;
    const positioned = win.getComputedStyle(parent).position === "static" || !win.getComputedStyle(parent).position;
    if (positioned) parent.style.position = "relative";
    const overlay = doc.createElement("div");
    overlay.dataset.composerPredictionGhost = "";
    overlay.setAttribute("aria-hidden", "true");
    const text = doc.createElement("span");
    const key = doc.createElement("kbd"); key.textContent = "Tab";
    overlay.append(text, key); parent.append(overlay);
    let composing = false;
    let dismissed = false;
    let lastGeneration: string | null = null;
    let visible = false;
    function update() {
      const state = binding.snapshot();
      if (state.generationId !== lastGeneration) { lastGeneration = state.generationId; dismissed = false; }
      const form = editor.closest("form[data-promptbox]");
      visible = state.eligible && !!state.suggestion && !composing && !dismissed && !editor.textContent?.trim() && editor.getAttribute("contenteditable") === "true" && !form?.hasAttribute("data-promptbox-voice-active");
      overlay.hidden = !visible;
      if (!visible) { delete editor.dataset.composerPredictionActive; return; }
      editor.dataset.composerPredictionActive = "";
      if (text.textContent !== state.suggestion) text.textContent = state.suggestion;
      const font = win.getComputedStyle(editor);
      text.style.webkitLineClamp = state.compact ? "1" : "3";
      const box = editor.getBoundingClientRect();
      const container = parent.getBoundingClientRect();
      Object.assign(overlay.style, {
        left: `${box.left - container.left + parent.scrollLeft}px`, top: `${box.top - container.top + parent.scrollTop}px`,
        width: `${box.width}px`, font: font.font, lineHeight: font.lineHeight, letterSpacing: font.letterSpacing,
        maxHeight: `${(parseFloat(font.lineHeight) || parseFloat(font.fontSize) * 1.7 || 22) * (state.compact ? 1 : 3)}px`,
      });
    }
    function dismiss() {
      dismissed = true; visible = false; overlay.hidden = true;
      delete editor.dataset.composerPredictionActive;
      binding.dismiss();
    }
    function accept(): boolean {
      update();
      if (!visible || !binding.accept()) return false;
      dismissed = true; visible = false; overlay.hidden = true;
      delete editor.dataset.composerPredictionActive;
      return true;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && visible) { dismiss(); return; }
      if (event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229 || composing) return;
      if (!accept()) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    // Tapping the label does what Tab does. pointerdown keeps the editor's focus.
    key.addEventListener("pointerdown", event => { event.preventDefault(); event.stopPropagation(); });
    key.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); if (!composing) accept(); });
    const onCompositionStart = () => { composing = true; dismiss(); update(); };
    const onCompositionEnd = () => { composing = false; update(); };
    editor.addEventListener("keydown", onKey, true);
    for (const event of ["beforeinput", "input", "paste", "drop"] as const) editor.addEventListener(event, dismiss, true);
    editor.addEventListener("compositionstart", onCompositionStart, true);
    editor.addEventListener("compositionend", onCompositionEnd, true);
    const Resize = win.ResizeObserver;
    const resize = Resize ? new Resize(update) : null;
    resize?.observe(editor); resize?.observe(parent);
    update();
    return {
      editor, update,
      dispose() {
        resize?.disconnect(); overlay.remove(); delete editor.dataset.composerPredictionActive;
        if (positioned && parent.style.position === "relative") parent.style.position = originalPosition;
        editor.removeEventListener("keydown", onKey, true);
        for (const event of ["beforeinput", "input", "paste", "drop"] as const) editor.removeEventListener(event, dismiss, true);
        editor.removeEventListener("compositionstart", onCompositionStart, true);
        editor.removeEventListener("compositionend", onCompositionEnd, true);
      },
    };
  }
  function sync() {
    if (disposed) return;
    for (const [anchor, decoration] of decorations) {
      if (!bindings.has(anchor) || !anchor.isConnected || !decoration.editor.isConnected) { decoration.dispose(); decorations.delete(anchor); }
    }
    for (const [anchor, binding] of bindings) {
      if (anchor.ownerDocument !== doc || !anchor.isConnected) continue;
      // A bridge lives inside its own composer's banner slot. Never pair editors by DOM order.
      const shell = anchor.closest("[data-promptbox-shell]");
      const editors = shell?.querySelectorAll<HTMLElement>("form[data-promptbox] [data-promptbox-editor-content] [contenteditable='true']");
      if (editors?.length !== 1) {
        decorations.get(anchor)?.dispose(); decorations.delete(anchor); continue;
      }
      const editor = editors[0];
      const current = decorations.get(anchor);
      if (current?.editor !== editor) { current?.dispose(); decorations.set(anchor, decorate(binding, editor)); }
      else current.update();
    }
  }
  refresh = sync;
  const observer = new win.MutationObserver(() => {
    if (frame !== null) return;
    frame = win.requestAnimationFrame(() => { frame = null; sync(); });
  });
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["contenteditable", "data-promptbox-voice-active"] });
  sync();
  return () => {
    disposed = true; observer.disconnect(); if (frame !== null) win.cancelAnimationFrame(frame);
    refresh = () => {}; decorations.forEach(decoration => decoration.dispose()); decorations.clear(); style.remove();
  };
}
