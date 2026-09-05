# The reactive core

`src/web/core/` is a small, hand-written reactivity system: `signal`,
`computed`, `effect`, `resource` and a hash `router`, plus two tiny DOM
helpers (`h` and `bind`). There is no framework underneath any of this --
ADR [0001](adr/0001-vanilla-typescript.md) explains why that's deliberate.
This document explains the concepts, aimed at someone who has used a
framework's reactivity (React state, Vue refs, Svelte stores) but never
had to build the mechanism themselves.

## A signal is a box with a "who's watching" list

A `signal<T>` is nothing more than a mutable value plus a set of
subscribers:

```ts
const count = signal(0);
count.get(); // 0
count.set(1);
count.update((current) => current + 1); // 2
```

On its own that's just a variable with getters and setters. What makes it
_reactive_ is what happens the moment something reads it while that
something is itself being tracked -- which is `computed` and `effect`.

## Automatic dependency tracking: the "who's asking" stack

This is the one idea that makes the whole thing work, and it's simpler than
it sounds. There is a single module-level variable, `activeTracker`, that
answers the question "is some computation currently being evaluated, and if
so, which one?"

- `computed(fn)` and `effect(fn)` both set `activeTracker` to themselves,
  call `fn()`, then restore whatever `activeTracker` was before (so a
  `computed` reading another `computed` nests correctly -- the inner one
  finishes and hands `activeTracker` back to the outer one).
- `signal.get()` checks `activeTracker`. If it's set, the signal adds that
  computation to its own subscriber list, and the computation remembers
  that it's now subscribed to this signal.

That's it -- no dependency array, no decorators, no compiler step. A
`computed` or `effect` "discovers" its dependencies simply by running its
own body and noticing which signals happened to get read along the way.

```ts
const price = signal(100);
const quantity = signal(2);
const total = computed(() => price.get() * quantity.get());
```

The first time `total`'s function runs, it reads `price` and `quantity` in
that order; both signals record `total`'s recompute function as a
subscriber. Change either one, and `total` recomputes.

### Conditional dependencies

Because tracking happens by _actually running the code_, not by statically
analyzing it, branches work exactly as you'd hope:

```ts
const useMetric = signal(true);
const meters = signal(10);
const feet = signal(33);
const distance = computed(() => (useMetric.get() ? meters.get() : feet.get()));
```

If `useMetric` is `true`, this run only reads `useMetric` and `meters` --
`feet` is never touched, so `distance` is _not_ subscribed to it. Changing
`feet` while on the metric branch does nothing to `distance`. Flip
`useMetric` to `false`, and the next recompute reads `useMetric` and `feet`
instead.

For this to stay correct across many recomputes, every run must forget its
_previous_ subscriptions before collecting new ones -- otherwise a
computation could stay subscribed to a signal it stopped actually reading
(a leak, and a source of spurious recomputes). Each computation keeps a
list of the exact `(subscriber-set, listener)` pairs it registered last
time, and unsubscribes from all of them before re-running. That list is
also what disposal uses.

## Effects, and why disposal matters

`effect(fn)` is the same tracking mechanism as `computed`, but instead of
producing a value to be read elsewhere, it exists to _do something_
(update the DOM, log, start a timer). It runs immediately, and returns a
disposer:

```ts
const dispose = effect(() => {
    document.title = `Count: ${count.get()}`;
});

// later, e.g. when navigating away from a page:
dispose();
```

If `fn` returns a function, that's treated as cleanup: it runs before the
_next_ re-run, and once more when the effect is disposed. This is the
standard "setup/teardown" pattern -- useful for anything that needs to
undo itself, like removing a listener the effect itself added:

```ts
effect(() => {
    const handler = () => console.log(mode.get());
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
});
```

**Why disposal has to actually remove subscriptions, not just stop the
effect from doing anything:** if `dispose()` only set a `disposed` flag and
left the effect's listener sitting in every signal's subscriber set, then
every `signal.set()` for the rest of the app's life would still iterate
over that dead listener, call it, and pay the cost of a no-op check --
forever. On a kiosk display that renders a new page (i.e. creates and
tears down a batch of effects) potentially thousands of times over weeks
of uptime, that's an unbounded memory and CPU leak, not a rounding error.
`dispose()` here walks the effect's own subscription list and removes
itself from every signal it was subscribed to, so a disposed effect leaves
_no trace_ in any signal -- verified in `signal.test.ts` by creating and
disposing 100 effects against one signal and confirming a long-lived
control effect still only fires once per `set()`, exactly as it did before
the churn.

## A worked example

```ts
import { signal, computed, effect } from './core/signal.js';

const celsius = signal(20);
const fahrenheit = computed(() => celsius.get() * 1.8 + 32);

const dispose = effect(() => {
    console.log(`${celsius.get()}°C is ${fahrenheit.get().toFixed(1)}°F`);
});
// logs immediately: "20°C is 68.0°F"

celsius.set(25);
// fahrenheit recomputes (its only dependency, celsius, changed),
// then the effect re-runs because it depends on both signals:
// logs: "25°C is 77.0°F"

dispose();
celsius.set(30); // nothing logs -- the effect is gone, and unsubscribed
```

## Beyond signal/computed/effect

- **`resource`** (`resource.ts`) wraps a polling `fetch`-like function in a
  `Signal`-like read of an `idle` / `loading` / `ready` / `error` state, so
  a page never touches a bare `Promise`. It's built the same way as
  everything else here: internally it just calls `signal.set()` as the
  fetch progresses.
- **`router`** (`router.ts`) exposes `currentRoute` as a
  `ReadonlySignal<Route>` that updates on `hashchange`. Because `Route` is
  a real discriminated union, anything that branches on `route.name` can do
  so exhaustively -- add a route and every unhandled `switch` becomes a
  compile error, not a silent gap.
- **`h`/`bind`** (`dom.ts`) are unrelated to tracking itself: `h` just
  builds real DOM nodes, and `bind` is a two-line convenience wrapper
  around `effect` that reruns a DOM mutation whenever a signal changes.

None of this batches updates or schedules work -- a `set()` call
synchronously walks and notifies its subscribers, right there, before
`set()` returns. That's a deliberate simplicity trade-off (see ADR 0001):
it makes the mental model "a write immediately propagates" instead of
"a write is queued and propagates on the next microtask/frame", which is
easier to reason about while learning the mechanism, at the cost of not
coalescing multiple writes into one recompute the way a production
framework's scheduler would.
