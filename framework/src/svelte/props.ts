// Shared prop shapes and the one helper every host primitive needs.
//
// Every host prop is written from a single attachment through `setProp`, the
// same call the other frameworks' primitives make. Nothing rides the element's
// own attributes: a `class=` or `focusable=` attribute would compile to
// Svelte's `set_class` / `set_attribute` and pull its attribute cache, class
// normaliser and `clsx` into the bundle for work `setProp` already does, and a
// `style` attribute is CSS text the native tree has no parser for. `onPress`
// has a second reason: an always-registered press wrapper would swallow the
// CIRCLE bubble that input.ts walks to the nearest ancestor with a handler.
//
// The attachment re-runs when any prop it reads changes; `setProp` compares
// each value against the node's last write, so only the changed prop reaches
// the host.

import type { Snippet } from "svelte";
import { setProp, type NodeMirror } from "../renderer-svelte.ts";

export type { NodeMirror };
export type StyleObject = Record<string, number | string>;
export type NodeRef = (node: NodeMirror) => void;

export interface ViewProps {
  class?: string;
  style?: StyleObject;
  onPress?: () => void;
  focusable?: boolean;
  /** DevTools semantic name shown in the component tree (docs/DEVTOOLS.md). */
  debugName?: string;
  nodeRef?: NodeRef;
  children?: Snippet;
}

export interface TextProps {
  class?: string;
  style?: StyleObject;
  debugName?: string;
  nodeRef?: NodeRef;
  children?: Snippet;
}

export interface ImageProps {
  class?: string;
  src?: string;
  style?: StyleObject;
  debugName?: string;
  nodeRef?: NodeRef;
}

export interface SpriteProps {
  class?: string;
  sprite?: string;
  style?: StyleObject;
  debugName?: string;
  nodeRef?: NodeRef;
}

export interface CompositorSurfaceProps {
  class?: string;
  package: string;
  focused?: boolean;
  style?: StyleObject;
  debugName?: string;
  nodeRef?: NodeRef;
}

/** `active` accepts a value or a getter, the convention the other frameworks use. */
export function resolveActive(active: boolean | (() => boolean) | undefined): boolean {
  if (typeof active === "function") return active();
  return active ?? true;
}

/** Write every host prop in `props` to `node`, skipping values the node already carries. */
export function applyHostProps(node: NodeMirror, props: Record<string, unknown>): void {
  for (const name in props) setProp(node, name, props[name], node.domAttrs?.[name]);
}
