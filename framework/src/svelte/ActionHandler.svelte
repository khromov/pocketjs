<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { onButtonPress, type ButtonPressOptions } from "../frame.svelte.ts";
  import { inputMarker, resolveActive, type NodeMirror } from "./props.ts";

  interface Props extends ButtonPressOptions {
    button: number;
    onPress: (pressed: number, buttons: number) => void;
    children?: Snippet;
  }

  let { button, onPress, allowWhenBlocked, active, latched, children }: Props = $props();

  // The marker places the press in the frame's document-ordered queue. The
  // mask, `allowWhenBlocked` and `latched` are read once, at registration, as
  // the Solid and Vue handlers read them; `active` and `onPress` are read on
  // each frame, so a parent's state change reaches the handler. untrack keeps
  // the attachment from re-registering, which would reset the press edge.
  const place = (marker: NodeMirror) =>
    untrack(() =>
      onButtonPress(
        button,
        (pressed, buttons) => onPress(pressed, buttons),
        { allowWhenBlocked, active: () => resolveActive(active), latched },
        inputMarker(marker),
      ),
    );
</script>

<view {@attach place}></view>
{@render children?.()}
