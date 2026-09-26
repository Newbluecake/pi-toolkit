/**
 * Shared event-bus channel name for "an aboveEditor extension widget just
 * transitioned from unmounted to mounted".
 *
 * Why this exists: pi's `setExtensionWidget` always does a Map `delete()`
 * then `set()` (node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js,
 * `setExtensionWidget`), and the widget container renders in Map insertion
 * order. That means the LAST widget to call `setWidget` always ends up last
 * (bottom) — including a widget that was already visible and simply calls
 * `setWidget` again on every data refresh, which used to be exactly what
 * pushed the todo widget below the fleet (agent tree) widget once both had
 * been re-set at least once.
 *
 * The fix (src/todo/index.ts, src/ui/fleet-widget.ts, src/stack.ts) is
 * mount-once + update-in-place: neither widget calls `setWidget` again for
 * an ordinary data refresh (fleet mutates its own component's `setLines` and
 * calls the captured `tui.requestRender()`; todo's component already reads
 * live state through a closure, so it needs no update path at all). Both
 * widgets only call `setWidget` again when transitioning between hidden and
 * visible, which is a `delete()+set()` producing a brand-new Map entry at
 * the end.
 *
 * That still leaves ONE ordering edge case: if the fleet widget is already
 * mounted (visible) and the todo widget then transitions hidden→visible for
 * the first time, todo's fresh `setWidget` call appends its entry to the end
 * of the Map, landing it BELOW fleet, which is the exact reverse of what we
 * want (todo — the calmer, more inspectable panel — should render above the
 * more volatile agent tree). This channel lets the todo widget announce that
 * transition; the fleet widget controller (wired up in src/stack.ts) listens
 * and, if it is itself currently visible, force-remounts itself so its Map
 * entry moves to the end again, landing back below todo.
 *
 * Kept in its own module (rather than defined in either src/todo/index.ts or
 * src/ui/fleet-widget.ts) so neither module has to import the other's
 * implementation — only the assembly layer (src/stack.ts, src/index.ts) has
 * to know both sides exist and wires them to this shared literal.
 */
export const TODO_WIDGET_MOUNTED_EVENT = "subagent:todo-widget-mounted";
