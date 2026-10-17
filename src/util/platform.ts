/** Whether this is an Apple platform, where ⌘ is the command key and Ctrl-click is a right-click. */
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Whether the platform's command modifier is held: ⌘ on Mac, Ctrl elsewhere (the Windows key would open the
 * Start menu on release).
 */
export const modHeld = (e: KeyboardEvent | PointerEvent): boolean => (IS_MAC ? e.metaKey : e.ctrlKey);
