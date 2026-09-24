import { scrubControlsPerLine } from "./panel.mjs";

/**
 * THE FOURTH FUNNEL (issue #404). Issue #382 gated the three that RENDER -- the overlay's finished pane
 * lines, the frame that draws them, and `send`, which answers the model-visible channel. pi's DIALOGS are
 * none of those: `ctx.ui.select`, `input`, `confirm` and `notify` are handed strings this extension builds
 * from stored fields, and nothing scrubbed them.
 *
 * Measured with a pause window whose `scope` carries an erase-display, an OSC-52 clipboard write and an
 * OSC-8 link: all three reach a select option and a confirm body. `pause-windows.mjs` checks only
 * `isNonEmptyString(w.scope)`, so the FILE is the whole validator, and `secrets-command.ts` has the same
 * shape through `renderProfiles`.
 *
 * IT IS MODEL-REACHABLE, which a first version of this denied in three places including a spec row. The
 * tool `execute` receives its own `ctx` from pi, never passing through the command door, and
 * `dispatch_trigger_edit`'s confirm body interpolates the model's own `flow` parameter. Its funnel is
 * `confirmedWrite`, so that is a door too.
 *
 * ONE WRAPPER PER DOOR, not at the ~75 call sites: a door is anywhere a `ctx` enters this extension from
 * pi. Wrapping twice is harmless, because the scrub is idempotent.
 *
 * `custom` IS NOT WRAPPED. It takes a FACTORY, and rebuilding one would change what pi calls. What the two
 * overlay factories return is already gated (`renderPanel` and `clipData`); `setup-wizard.ts`'s attached
 * view is NOT, and that is its own residual rather than something this wrapper can reach.
 */
export function gateDialogs(ctx) {
  const ui = ctx?.ui;
  if (!ui) return ctx;

  /**
   * PER LINE, because a confirm body is written with newlines and a whole-string scrub would run its
   * paragraphs together -- the same reason `openSandboxSession`'s writes scrub per line.
   *
   * Anything that is not a string, array or PLAIN object is passed through: a class instance, a Map or a
   * function is not a string this extension composed, and rebuilding one would change what pi receives.
   *
   * THE PLAIN-OBJECT BRANCH IS DEFENSIVE AND CURRENTLY UNREACHABLE, recorded rather than left for the next
   * reader to re-derive: at this pin `select` takes `(title, options: string[])` and the only object any
   * dialog receives is `{ signal?, timeout? }`, which carries no strings. Removing the branch therefore
   * changes nothing observable and no test can see it. It stays because the shape of these signatures is
   * pi's, not ours, and a future option bag with a label in it would otherwise arrive raw.
   */
  const clean = (v) => {
    if (typeof v === "string") return scrubControlsPerLine(v);
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
    }
    return v;
  };

  /**
   * THE SELECTION IS TRANSLATED BACK, and without this the gate is a functional regression rather than a
   * fix. pi's selector returns THE EXACT OPTION STRING IT WAS HANDED. Hand it a scrubbed copy and the
   * caller's own `labels.indexOf(picked)` is -1 against its unscrubbed array, so `editPauseWindowViaDialogs`,
   * `deletePauseWindowViaDialogs` and both scoped-limit twins return silently: the operator picks a window
   * and nothing happens, with no notify and no error. Measured on the first version of this gate, on all
   * four, and it is the silent no-op `CLAUDE.md` calls the worst outcome available.
   *
   * So the wrapper maps the answer back to the caller's own array by the position of the scrubbed string it
   * handed pi.
   *
   * THAT MAPPING IS AMBIGUOUS WHEN TWO OPTIONS SCRUB ALIKE, and saying so is the honest part: two rows
   * differing only in control bytes become the same string, pi returns that string, and the first of them
   * wins. The information is genuinely gone by then -- pi answers with a string, not an index -- so no
   * lookup here can recover it. A first version of this comment claimed position solved that; it does not.
   *
   * Both live families of caller are collision-proof BY CONSTRUCTION, which is why the ambiguity is a
   * residual rather than a defect: the pause-window and scoped-limit pickers prefix every label with `#N`,
   * and the wizard's skill picker offers names `listRepoSkills` has already filtered through
   * `SKILL_NAME_RE`, which admits no control byte at all. A future picker whose options can differ only in
   * control bytes would need its own index prefix.
   */
  const gatedSelect = async (...args) => {
    const cleaned = args.map(clean);
    const picked = await ui.select(...cleaned);
    const shown = cleaned[1];
    const original = args[1];
    if (!Array.isArray(shown) || !Array.isArray(original)) return picked;
    const at = shown.indexOf(picked);
    return at >= 0 ? original[at] : picked;
  };

  const wrap = (name) => (typeof ui[name] === "function" ? (...args) => ui[name](...args.map(clean)) : ui[name]);
  const gatedUi = { ...ui, select: typeof ui.select === "function" ? gatedSelect : ui.select, input: wrap("input"), confirm: wrap("confirm"), notify: wrap("notify") };

  // THE CONTEXT'S OWN SHAPE IS PRESERVED, not spread. pi builds its command context with guarded GETTERS and
  // its own source carries the comment forbidding exactly this: "a spread would eagerly read them once and
  // freeze the old values, bypassing stale-instance checks". Copying the descriptors keeps them lazy, and
  // only `ui` is replaced.
  const out = Object.defineProperties(Object.create(Object.getPrototypeOf(ctx) ?? Object.prototype), Object.getOwnPropertyDescriptors(ctx));
  // A GETTER, not a value, and for the reason the descriptor copy exists: `ui` is the one property this
  // wrapper replaces, so freezing it would undo on that property exactly what the copy protects on every
  // other. pi's own `ui` getter throws once its context is stale; reading through this one keeps that.
  Object.defineProperty(out, "ui", { get: () => gatedUi, enumerable: true, configurable: true });
  return out;
}
