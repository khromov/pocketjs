// Shared types of the Svelte VAPOR TODO. Type-only imports are inlined into
// the generated program by the front end; nothing here executes.

export interface Todo {
  text: string;
  done: boolean;
}

export type Keymap = Record<number, () => void>;
