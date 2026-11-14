// @title PocketJS: Hero
import { mount } from "@pocketjs/framework/svelte";
import { TICKS_PER_SECOND } from "@pocketjs/framework/svelte/clock";
import Hero from "./app.svelte";

mount(Hero, { props: { presentationHz: TICKS_PER_SECOND } });
