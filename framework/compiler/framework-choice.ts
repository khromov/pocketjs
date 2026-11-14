import type { PocketFramework } from "../../contracts/spec/pocket-manifest.ts";
export type { PocketFramework };
export const FRAMEWORK_CHOICES = {
  solid: { label: "Solid", outputSuffix: "" },
  "vue-vapor": { label: "Vue Vapor", outputSuffix: ".vue-vapor" },
  octane: { label: "Octane", outputSuffix: ".octane" },
  svelte: { label: "Svelte", outputSuffix: ".svelte" },
} satisfies Record<PocketFramework, { label: string; outputSuffix: string }>;
export function parseFramework(value: string | undefined, source: string): PocketFramework {
  if (value === undefined || value === "") return "solid";
  if (value === "solid" || value === "vue-vapor" || value === "octane" || value === "svelte") return value;
  throw new Error(`PocketJS ${source}: framework must be "solid", "vue-vapor", "octane" or "svelte"`);
}
