// vapor/oracle/renderer-svelte.ts — Svelte's custom renderer over the micro-DOM.
//
// The Svelte oracle runs a .svelte component on the real vendored Svelte 5
// runtime. Svelte's renderer contract is DOM-shaped (fragments, comments,
// sibling walking); every node it asks for is a VaporElement / VaporText /
// VaporComment from dom.ts, the same tree the Vue oracle mounts into, so the
// grid painter (paint.ts) reads both oracles the same way.
//
// Nodes are created through the `__vaporDocument` global the test process
// installs (dom.ts installOracleDom), never through a bundled copy of dom.ts:
// this module is bundled into the oracle, and a class bundled twice fails the
// painter's instanceof checks. dom.ts is imported for its types only.
//
// Compiled components import this module as `$renderer` — boot.ts bakes the
// absolute path in through `experimental.customRenderer` — and the entry
// passes the same object to `mount()`. Svelte compares the two by identity:
// a component whose renderer differs from the mount renderer is treated as
// foreign, so this file must be the one module both sides import.

import { createRenderer } from "svelte/renderer";
import type { VaporComment, VaporDocument, VaporElement, VaporNode, VaporText } from "./dom.ts";

const FRAGMENT = "#fragment";
const DOM_TEXT = 3;
const DOM_COMMENT = 8;

type OracleNode = VaporElement | VaporText | VaporComment;

function doc(): VaporDocument {
  const d = (globalThis as Record<string, unknown>).__vaporDocument as VaporDocument | undefined;
  if (!d) throw new Error("pocket vapor oracle: installOracleDom() must run before the Svelte bundle mounts");
  return d;
}

const isFragment = (node: OracleNode): node is VaporElement =>
  node.nodeType === 1 && (node as VaporElement).tag === FRAGMENT;

// dom.ts types its tree as the abstract VaporNode; the renderer only ever
// creates the three concrete kinds, so the cast is by construction.
const concrete = (node: VaporNode | null): OracleNode | null => node as OracleNode | null;

const renderer = createRenderer<{
  fragment: VaporElement;
  element: VaporElement;
  text: VaporText;
  comment: VaporComment;
}>({
  createFragment: () => doc().createElement(FRAGMENT) as VaporElement,
  createElement: (name) => doc().createElement(name) as VaporElement,
  createTextNode: (data) => doc().createTextNode(data),
  createComment: (data) => doc().createComment(data),

  nodeType: (node) => {
    if (node.nodeType === DOM_TEXT) return "text";
    if (node.nodeType === DOM_COMMENT) return "comment";
    return isFragment(node) ? "fragment" : "element";
  },

  getNodeValue: (node) => node.text,

  setText(node, text) {
    if (node.nodeType === DOM_TEXT || node.nodeType === DOM_COMMENT) (node as VaporText).text = text;
    else (node as VaporElement).textContent = text;
  },

  getFirstChild: (node) => concrete(node.firstChild),
  getLastChild: (node) => concrete(node.lastChild),
  getParent: (node) => node.parent,
  getNextSibling: (node) => concrete(node.nextSibling),

  insert(parent, node, anchor) {
    if (isFragment(node)) {
      // a fragment is a staging list: inserting it inserts its children
      for (const child of node.children.slice()) parent.insertBefore(child, anchor ?? null);
      return;
    }
    parent.insertBefore(node, anchor ?? null);
  },

  remove(node) {
    node.parent?.removeChild(node);
  },

  getAttribute: (element, name) => element.getAttribute(name),
  hasAttribute: (element, name) => element.hasAttribute(name),
  setAttribute: (element, key, value) => element.setAttribute(key, value),
  removeAttribute: (element, name) => element.removeAttribute(name),

  addEventListener(target, type) {
    throw new Error(
      `pocket vapor oracle: <${target.tag}> has no "${type}" event — input arrives through onButton/onAxisDelta`,
    );
  },
  removeEventListener() {},
});

export default renderer;
