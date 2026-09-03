// Show shortcuts.
//
// The desktop binds Space, Enter, S and Esc application-wide
// (MainComponent.cpp:1269-1320). A browser cannot simply copy that: Space
// scrolls, Enter submits, and every text input on the page swallows all of
// them. Getting this wrong means the operator presses Space during a show and
// scrolls the cue list instead of firing the cue.
//
// So the rules are explicit:
//
//   * While a text field has focus, transport keys do nothing — the operator is
//     typing a cue name, and firing the show would be worse than doing nothing.
//   * ESCAPE IS THE EXCEPTION. Panic is a safety control and must work from
//     anywhere, so it fires from a text field too, blurring it on the way out.
//   * Space is preventDefault-ed so the page never scrolls under a GO.

export interface ShortcutActions {
  go: () => void;
  releaseVamps: () => void;
  stopAll: () => void;
  panic: () => void;
  togglePause: () => void;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  if (target.isContentEditable) return true;

  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;

  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    // A range slider is not text entry: the master fader should not swallow GO.
    return type !== 'range' && type !== 'checkbox' && type !== 'button';
  }

  return false;
}

export function installShortcuts(actions: ShortcutActions): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // Panic first, and unconditionally.
    if (e.key === 'Escape') {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      e.preventDefault();
      actions.panic();
      return;
    }

    if (isTextEntry(e.target)) return;
    if (e.repeat) return; // holding GO must not fire the whole show

    switch (e.key) {
      case ' ':
        e.preventDefault();
        actions.go();
        break;

      case 'Enter':
        e.preventDefault();
        actions.releaseVamps();
        break;

      case 's':
      case 'S':
        e.preventDefault();
        actions.stopAll();
        break;

      case 'p':
      case 'P':
        e.preventDefault();
        actions.togglePause();
        break;
    }
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
