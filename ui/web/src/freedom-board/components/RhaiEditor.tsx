/**
 * RhaiEditor — CodeMirror 6 wrapper for Rhai script editing.
 *
 * Isolated editor component. Knows nothing about persistence, script names,
 * scopes, or WASM reload. ScriptPanel owns all content-management concerns;
 * this component owns document editing, syntax highlighting, keybindings,
 * and read-only mode.
 *
 * Uses Rust-mode highlighting as a temporary stand-in for Rhai. Rhai syntax
 * is close enough to Rust (fn, let, if, for, //, string literals) that the
 * grammar covers all common constructs. Rust-only keywords (pub, struct,
 * impl, mut) will highlight if typed, but Rhai users won't use them.
 * A proper Rhai language package should replace this when compile diagnostics
 * or autocomplete are added.
 *
 * TECH DEBT: Rust highlighting is a temporary proxy for Rhai.
 */

import { useRef, useEffect } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { rust } from '@codemirror/lang-rust';
import { oneDark } from '@codemirror/theme-one-dark';

// ── Props ─────────────────────────────────────────────────────────────

interface RhaiEditorProps {
  /** Current document text. Controlled externally by ScriptPanel. */
  value: string;
  /** Fired on every document change (keystroke, paste, undo). */
  onChange: (value: string) => void;
  /** When true, editor is non-editable (play mode). */
  readOnly?: boolean;
  /** Placeholder text when document is empty. */
  placeholder?: string;
}

// ── Compartments ──────────────────────────────────────────────────────
// Compartments allow reconfiguring extensions without recreating the
// editor. Each compartment wraps one facet that can change at runtime.

const readOnlyCompartment = new Compartment();

// ── Custom theme overrides ────────────────────────────────────────────
// oneDark is close to the Freedom Board panel colors but needs minor
// tweaks: background matches #080c14, no visible border on focus.

const panelTheme = EditorView.theme({
  '&': {
    fontSize: '12px',
    height: '100%',
  },
  '.cm-content': {
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", "Consolas", monospace',
    caretColor: '#e0a060',
  },
  '.cm-gutters': {
    backgroundColor: '#0a0e18',
    color: '#334455',
    borderRight: '1px solid #1a2a4a',
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#111828',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: '#e0a060',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
}, { dark: true });

// ── Component ─────────────────────────────────────────────────────────

export function RhaiEditor({
  value,
  onChange,
  readOnly = false,
  placeholder,
}: RhaiEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Stable callback ref to avoid recreating extensions on every render.
  // The ref always points to the latest onChange so the update listener
  // doesn't go stale when ScriptPanel's useCallback identity changes.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Guard: when true, the updateListener suppresses onChange calls.
  // Set during programmatic document replacements (external value sync)
  // so that selecting a different script doesn't falsely mark dirty.
  const syncingRef = useRef(false);

  // ── Create editor on mount ──────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !syncingRef.current) {
        onChangeRef.current(update.state.doc.toString());
      }
    });

    const extensions = [
      basicSetup,
      rust(),
      oneDark,
      panelTheme,
      updateListener,
      readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
      // Prevent CM from consuming Ctrl+S — let it bubble to ScriptPanel's
      // onKeyDown handler for save.
      keymap.of([{
        key: 'Mod-s',
        run: () => false, // false = not handled, event propagates
      }]),
    ];

    if (placeholder) {
      // Import placeholder dynamically to keep the main bundle slim
      // if it's not used. For now, just set empty — placeholder support
      // can be added via @codemirror/view placeholder() if needed.
    }

    const state = EditorState.create({
      doc: value,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync external value → editor ────────────────────────────────
  // When ScriptPanel selects a different script, the value prop changes.
  // We must update the editor document without losing cursor/scroll
  // if the value is identical (e.g., re-render without actual change).

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      // Programmatic replacement — suppress onChange so ScriptPanel
      // doesn't falsely mark the buffer dirty on script selection.
      syncingRef.current = true;
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
      syncingRef.current = false;
    }
  }, [value]);

  // ── Sync readOnly prop → compartment ────────────────────────────

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(
        EditorState.readOnly.of(readOnly)
      ),
    });
  }, [readOnly]);

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        background: '#080c14',
        opacity: readOnly ? 0.5 : 1,
      }}
    />
  );
}
