// @title PocketJS: Launcher
import { mount } from "@pocketjs/framework/svelte";
import Launcher from "./app.svelte";
import { REGISTRY } from "./registry.generated.ts";

mount(Launcher, { props: { registry: REGISTRY } });
