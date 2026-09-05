import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { ActiveCueInfo, Standby } from '@webcue/core';
import { WebCueEngine } from '@webcue/engine';

import { ActiveCues } from './components/ActiveCues.tsx';
import { CueList } from './components/CueList.tsx';
import { FoldPrompt } from './components/FoldPrompt.tsx';
import { Inspector } from './components/Inspector.tsx';
import { TransportBar } from './components/TransportBar.tsx';
import { installShortcuts } from './keyboard.ts';
import { AppStore } from './store.ts';

// ?url so Vite emits these as assets rather than trying to bundle them: the
// worklet is loaded by addModule() at runtime and the wasm is fetched, so
// neither is a module graph entry. Both are placed here by webcue/build.sh.
import wasmUrl from './engine/webcue-engine.wasm?url';
import workletUrl from './engine/webcue-processor.js?url';

declare const __APP_VERSION__: string;

export function App() {
  const store = useMemo(() => new AppStore(), []);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const showInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const bundleInput = useRef<HTMLInputElement>(null);

  const running = state.status === 'running';
  const anythingPlaying = state.active.length > 0;
  const anythingVamping = state.active.some((a) => a.vamping);

  const selected =
    state.selectedIndex >= 0 ? state.show.cues[state.selectedIndex] : undefined;

  // The play head only shows when the cue being edited is the one running, so
  // the marker never claims to be somewhere it is not.
  const playhead =
    selected !== undefined
      ? (state.active.find((a) => a.cueId === selected.id)?.position ?? null)
      : null;

  const start = useCallback(
    () =>
      store.start(() =>
        WebCueEngine.create({
          wasmUrl,
          workletUrl,
          numOutputs: 2,
        }),
      ),
    [store],
  );

  // Offer a folder remembered from a previous session, without reconnecting it:
  // permission has to be asked for again, and silently regaining disk access
  // because a page once had it is not something a browser allows or should.
  useEffect(() => {
    void store.recallFolder();
  }, [store]);

  useEffect(
    () =>
      installShortcuts({
        go: () => store.go(),
        releaseVamps: () => store.releaseAllVamps(),
        stopAll: () => store.stopAll(2),
        panic: () => store.panic(),
        togglePause: () => store.togglePause(),
      }),
    [store],
  );

  // Audio dies instantly and without a fade if the tab navigates away, so warn
  // while anything is sounding. There is no desktop equivalent of this.
  useEffect(() => {
    if (!anythingPlaying) return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [anythingPlaying]);

  // Drag events fire on every element the pointer crosses, so a naive
  // enter/leave pair flickers the overlay as the cursor moves over children.
  // Counting enters and leaves is the standard fix.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
    }
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    // Without preventDefault the browser navigates to the dropped file, which
    // throws away the show.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);

      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) void store.handleDroppedFiles(files);
    },
    [store],
  );

  const onToggleExpand = useCallback((cueId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cueId)) next.delete(cueId);
      else next.add(cueId);
      return next;
    });
  }, []);

  const onStandby = useCallback((standby: Standby) => store.setStandby(standby), [store]);

  const onStopVoice = useCallback((info: ActiveCueInfo) => store.stopVoice(info, 2), [store]);

  const onReleaseVamp = useCallback((info: ActiveCueInfo) => store.releaseVampVoice(info), [store]);

  return (
    <div
      className="app"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <header className="titlebar">
        <h1>
          webcue <span className="dim">{__APP_VERSION__}</span>
        </h1>

        <div className="show-name">
          {state.showName}
          {state.dirty && <span className="dirty" title="Unsaved changes"> *</span>}
        </div>

        <div className="titlebar-actions">
          <button
            type="button"
            onClick={() =>
              state.canSaveInPlace ? void store.openShowViaPicker() : showInput.current?.click()
            }
          >
            Open show
          </button>

          <button
            type="button"
            onClick={() =>
              state.canSaveInPlace ? void store.openBundleViaPicker() : bundleInput.current?.click()
            }
            title="Open a .cueshowpack — a show with its audio inside it"
          >
            Open bundle
          </button>

          {state.canPickFolder && (
            <button
              type="button"
              disabled={state.show.cues.length === 0}
              onClick={() => void store.pickShowFolder()}
              title="Point webcue at the folder the show lives in, so its relative audio paths resolve"
            >
              {state.folderName ? `Folder: ${state.folderName}` : 'Show folder'}
            </button>
          )}

          <button
            type="button"
            disabled={state.show.cues.length === 0}
            onClick={() => audioInput.current?.click()}
          >
            Add audio
          </button>

          <span className="titlebar-divider" />

          <button
            type="button"
            disabled={state.show.cues.length === 0}
            onClick={() => void store.save()}
          >
            Save
          </button>

          <button
            type="button"
            disabled={state.show.cues.length === 0}
            onClick={() => store.exportBundle()}
            title="Download the show and its audio as one file"
          >
            Export bundle
          </button>
        </div>

        <input
          ref={showInput}
          type="file"
          accept=".cueshow,application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void store.openShow(file);
            e.target.value = '';
          }}
        />

        <input
          ref={audioInput}
          type="file"
          accept="audio/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void store.addAudioFiles(e.target.files);
            e.target.value = '';
          }}
        />

        <input
          ref={bundleInput}
          type="file"
          accept=".cueshowpack,application/zip"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void store.openBundle(file);
            e.target.value = '';
          }}
        />
      </header>

      {state.folderNeedsPermission && (
        <div className="permission-strip">
          <strong>{state.folderName}</strong> is remembered from last time, but a page has to ask
          again before it can read your disk.
          <button type="button" onClick={() => void store.grantRememberedFolder()}>
            Reconnect folder
          </button>
        </div>
      )}

      {!running && (
        <div className="start-strip">
          {state.status === 'failed' ? (
            <>
              <strong>The audio engine did not start.</strong>{' '}
              <span className="dim">{state.error}</span>{' '}
              <button type="button" onClick={start}>
                Try again
              </button>
            </>
          ) : (
            <>
              <button type="button" className="go" disabled={state.status === 'starting'} onClick={start}>
                {state.status === 'starting' ? 'Starting...' : 'Start audio'}
              </button>
              <span className="dim">
                A browser will not start audio without a click, so this has to be done by hand
                before the first GO.
              </span>
            </>
          )}
        </div>
      )}

      <TransportBar
        cues={state.show.cues}
        standby={state.standby}
        running={running}
        paused={state.paused}
        anythingVamping={anythingVamping}
        anythingPlaying={anythingPlaying}
        masterGainDb={state.masterGainDb}
        onGo={() => store.go()}
        onStopAll={() => store.stopAll(2)}
        onTogglePause={() => store.togglePause()}
        onReleaseVamps={() => store.releaseAllVamps()}
        onPanic={() => store.panic()}
        onMasterGain={(db) => store.setMasterGainDb(db)}
      />

      {state.missingAudio.length > 0 && !state.folderNeedsPermission && (
        <div className="warning-strip">
          {state.missingAudio.length} audio file
          {state.missingAudio.length === 1 ? '' : 's'} not loaded — those cues will not play.
          {state.canPickFolder && (
            <button type="button" onClick={() => void store.pickShowFolder()}>
              Point at the show folder
            </button>
          )}
          <button type="button" onClick={() => audioInput.current?.click()}>
            Pick files
          </button>
        </div>
      )}

      <main className="body">
        <div className="list-pane">
          <div className="list-toolbar">
            <button type="button" disabled={!running} onClick={() => store.addCue()}>
              Add cue
            </button>
            <button
              type="button"
              disabled={selected === undefined || state.selectedIndex <= 0}
              onClick={() => store.moveCue(state.selectedIndex, state.selectedIndex - 1)}
            >
              Move up
            </button>
            <button
              type="button"
              disabled={selected === undefined || state.selectedIndex >= state.show.cues.length - 1}
              onClick={() => store.moveCue(state.selectedIndex, state.selectedIndex + 1)}
            >
              Move down
            </button>

            <span className="dim toolbar-hint">or drop audio files anywhere</span>
          </div>

          <CueList
            cues={state.show.cues}
            standby={state.standby}
            selectedIndex={state.selectedIndex}
            active={state.active}
            missingAudio={state.missingAudio}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            onStandby={onStandby}
            onSelect={(index) => store.setSelected(index)}
            onFire={(index) => store.fireCue(index)}
          />

          {selected && (
            <Inspector
              cue={selected}
              cues={state.show.cues}
              peaks={store.getPeaks(selected.audioFile)}
              playhead={playhead}
              numOutputs={state.numOutputs}
              onChange={(patch) => store.updateCue(selected.id, patch)}
              onAudition={(from) => store.audition(selected, from)}
              onPickAudio={(file) => void store.setCueAudio(selected.id, file)}
              onDelete={() => store.removeCue(selected.id)}
            />
          )}
        </div>

        <ActiveCues active={state.active} onStopVoice={onStopVoice} onReleaseVamp={onReleaseVamp} />
      </main>

      <footer className="statusbar">
        <span className="dim">
          {running ? `${state.numOutputs} out` : 'engine stopped'} · {state.show.cues.length} cues
        </span>
        <span className="log mono dim">{state.log[state.log.length - 1] ?? ''}</span>
      </footer>

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <strong>Drop to add cues</strong>
            <span className="dim">
              One cue per audio file, in the order you dragged them. A{' '}
              <code>.cueshow</code> or <code>.cueshowpack</code> opens instead.
            </span>
          </div>
        </div>
      )}

      {state.foldPromptOpen && (
        <FoldPrompt
          candidates={state.foldCandidates}
          numOutputs={state.numOutputs}
          onFold={() => store.applyFold()}
          onDismiss={() => store.dismissFold()}
        />
      )}
    </div>
  );
}
