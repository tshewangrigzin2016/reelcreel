import { useQuery } from "@tanstack/react-query";
import { queryClient, libraryChanged } from "@/lib/query";
const LibraryManager = lazy(() =>
  import("@/components/LibraryManager").then((module) => ({
    default: module.LibraryManager,
  })),
);
import { BatchComposer, type BatchLoad } from "@/components/BatchComposer";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Toaster, toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  Download04Icon,
  LibraryIcon,
  Loading03Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import type {
  DownloadItem,
  DownloadOptions,
  PlanBatchEntry,
  PlanBatchResult,
  PlaylistDownloadContext,
  PlaylistEntry,
  PlaylistPreview,
  ProbeOutcome,
  SelectionMode,
  Settings as SettingsType,
} from "@shared/types";
import { isPlaylistUrl, normalizeUrl } from "@shared/url";
import {
  buildRequestKey,
  buildSelectionFingerprint,
} from "@shared/request-key";
import { api, probePlaylistStream } from "@/lib/api";
import { sectionMode, unifiedRows, videoMetaToEntry } from "@/lib/rows";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useJobsStream } from "@/lib/useJobsStream";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MetadataCard } from "@/components/MetadataCard";
import { FormatPicker } from "@/components/FormatPicker";
import { SourceFormats } from "@/components/SourceFormats";
import { PlaylistPreviewCard } from "@/components/PlaylistPreviewCard";
import { PlaylistTable } from "@/components/PlaylistTable";
import { RevalidationBanner } from "@/components/RevalidationBanner";
import { SettingsDialog } from "@/components/SettingsDialog";
import { CommandPalette } from "@/components/CommandPalette";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ViewToggle } from "@/components/ViewToggle";

const DEFAULT_OPTIONS: DownloadOptions = {
  embedThumbnail: false,
  embedMetadata: true,
  embedChapters: false,
  subtitles: false,
  subtitleLangs: "en.*",
  sponsorblock: false,
};

const EMPTY_JOBS: Record<string, import("@shared/types").JobState> = {};

const SOURCE_CHIPS = ["video", "shorts", "playlist", "live vod"];

/**
 * Ceiling on one automatic re-check.
 *
 * Re-evaluating costs one network probe per video, so a 200-item selection
 * cannot be re-planned on every dropdown change. Staying under this keeps the
 * sweep interactive; anything beyond it is still reachable through the manual
 * re-check, which reports the same thing.
 */
const REEVALUATE_CAP = 60;

export default function App() {
  useJobsStream();

  const [view, setView] = useState<"download" | "history">("download");
  const [probeResult, setProbeResult] = useState<ProbeOutcome | null>(null);
  /**
   * Jobs are read whatever is on screen, not only for a playlist: a reload
   * brings jobs with no probe result at all, and the single-video path is a
   * one-row list now, so both need the queue.
   */
  const jobs = useAppStore((state) =>
    view === "download" ? state.jobs : EMPTY_JOBS,
  );
  const connected = useAppStore((state) => state.connected);
  const presetsQuery = useQuery({
    queryKey: ["presets"],
    queryFn: api.presets,
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: api.settings,
  });
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health });
  const presets = presetsQuery.data ?? [];
  const settings = settingsQuery.data ?? null;
  const health = healthQuery.data ?? null;
  const setSettings = (s: SettingsType) =>
    queryClient.setQueryData(["settings"], s);

  const [url, setUrl] = useState("");
  const [probing, setProbing] = useState(false);
  /** True while a playlist is still filling in after its first entries landed. */
  const [streaming, setStreaming] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  /**
   * First-video thumbnail for a playlist URL. Recognised from the URL shape
   * alone and answered from a single yt-dlp request, so it lands well before
   * the full enumeration that feeds the table.
   */
  const [preview, setPreview] = useState<PlaylistPreview | null>(null);
  const [previewPending, setPreviewPending] = useState(false);

  const [group, setGroup] = useState<"video" | "audio">("video");
  const [presetId, setPresetId] = useState("mp4-h264");
  const [options, setOptions] = useState<DownloadOptions>(DEFAULT_OPTIONS);
  const requestKey = useMemo(
    () => buildRequestKey(presetId, options),
    [presetId, options],
  );
  const layout = useAppStore((state) => state.layout);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<SelectionMode>("all");

  /** Run time chosen in the batch composer, applied when the batch is queued. */
  const [batchSchedule, setBatchSchedule] = useState<number | undefined>();
  /** Pasted URLs the server could not read, so a dead link is visible. */
  const [batchErrors, setBatchErrors] = useState<string[]>([]);

  /**
   * Drops the batch-only context.
   *
   * Both belong to a pasted list, not to whatever is on screen. Without this a
   * playlist pasted after a batch would silently inherit that batch's run time,
   * and would report the batch's unreadable links under its own heading.
   */
  const clearBatchContext = useCallback(() => {
    setBatchSchedule(undefined);
    setBatchErrors([]);
  }, []);

  /**
   * Video ids that have ever gained a job, keyed on the *gain* of one.
   *
   * Three code paths select everything on arrival -- a playlist probe, a
   * pasted batch, and entries still streaming in -- and all three would happily
   * select videos that are already downloading, so "Download 200" would queue
   * 200 duplicates. Reading this on each of them is what makes same-video
   * dedup a consequence of the one-row-per-video union rather than a rule
   * anybody has to remember.
   */
  const withJobRef = useRef<Set<string>>(new Set());
  const seedableIds = useCallback(
    (entries: PlaylistEntry[]) =>
      entries.filter((e) => !withJobRef.current.has(e.id)).map((e) => e.id),
    [],
  );

  /**
   * A pasted batch becomes a synthetic playlist result.
   *
   * That is the whole fix. From here on the batch is indistinguishable from a
   * playlist URL: it renders the same selection table, answers to the same
   * format card, is re-checked against the same "already downloaded" data and
   * is queued by the same button. The alternative -- a second code path with its
   * own format handling and its own download button -- is exactly how the batch
   * ended up able to do neither.
   */
  const loadBatch = useCallback((load: BatchLoad) => {
    // A pasted list supersedes whatever is still streaming in from the URL box.
    probeCancelRef.current?.();
    probeCancelRef.current = null;
    probeRequestRef.current?.abort();
    probeRequestRef.current = null;
    probeGenerationRef.current++;

    setProbing(false);
    setStreaming(false);
    setProbeError(null);
    setBatchSchedule(load.scheduledAt);
    setBatchErrors(load.errors);
    setSelectionPlan([]);
    setPlanCounts(null);
    setProbeResult({
      kind: "playlist",
      playlist: {
        id: "batch",
        title: `Batch · ${load.entries.length} video${load.entries.length === 1 ? "" : "s"}`,
        entryCount: load.entries.length,
        truncated: false,
        batch: true,
      },
      entries: load.entries,
    });
    // A playlist starts fully selected, and so does a pasted list -- the mode
    // switch narrows it down from there, exactly as it does for a playlist.
    // Videos that already have a job are left out: without that, loading a
    // playlist whose videos are currently downloading would queue all of them
    // a second time.
    setSelected(new Set(seedableIds(load.entries)));
    setMode("all");
    modeRef.current = "all";
  }, []);

  // Stream callbacks outlive the render that created them, so the current mode
  // has to be read from a ref rather than the closure.
  const modeRef = useRef<SelectionMode>(mode);
  const probeCancelRef = useRef<(() => void) | null>(null);
  const probeRequestRef = useRef<AbortController | null>(null);
  const probeGenerationRef = useRef(0);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  /**
   * What the server's planner says about each selected video we already hold.
   *
   * Produced by the same engine the download path uses, so "3 need updating"
   * here and three rows appearing in the queue after a click cannot disagree.
   */
  const [selectionPlan, setSelectionPlan] = useState<PlanBatchEntry[]>([]);
  const [planCounts, setPlanCounts] = useState<
    PlanBatchResult["counts"] | null
  >(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const ownedQuery = useQuery({
    queryKey: ["ownership", "all"],
    queryFn: () => api.historyIds(),
  });
  const scopedQuery = useQuery({
    queryKey: ["ownership", requestKey],
    queryFn: () => api.historyIds(requestKey),
  });
  const ownedIds = useMemo(
    () => new Set(ownedQuery.data ?? []),
    [ownedQuery.data],
  );
  const downloadedIds = useMemo(
    () => new Set(scopedQuery.data ?? []),
    [scopedQuery.data],
  );
  const refreshHealth = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["health"] });
  }, []);
  useEffect(() => {
    const error =
      settingsQuery.error ??
      healthQuery.error ??
      presetsQuery.error ??
      ownedQuery.error ??
      scopedQuery.error;
    if (error) toast.error(error.message);
  }, [
    settingsQuery.error,
    healthQuery.error,
    presetsQuery.error,
    ownedQuery.error,
    scopedQuery.error,
  ]);

  const runProbe = useCallback(async (raw: string) => {
    const normalized = normalizeUrl(raw);

    // A new URL supersedes whatever is still streaming in.
    probeCancelRef.current?.();
    probeCancelRef.current = null;
    probeRequestRef.current?.abort();
    probeRequestRef.current = null;
    const generation = ++probeGenerationRef.current;
    const stale = () => generation !== probeGenerationRef.current;

    if (!normalized) {
      setProbeResult(null);
      setProbeError(null);
      clearBatchContext();
      return;
    }

    setProbing(true);
    setStreaming(false);
    setProbeError(null);
    // A probed URL supersedes any pasted batch, so its schedule and unreadable
    // links must not follow the new result into the download button.
    clearBatchContext();

    // Playlists stream in so the selection table appears while yt-dlp is still
    // enumerating — a 200-item playlist otherwise sits blank for minutes.
    if (isPlaylistUrl(normalized)) {
      const streamed = await new Promise<boolean>((resolve) => {
        let received = 0;

        const cancel = probePlaylistStream(normalized, {
          onMeta: (meta) => {
            if (stale()) return;
            setProbeResult({
              kind: "playlist",
              playlist: {
                id: meta.id,
                title: meta.title,
                uploader: meta.uploader,
                webpageUrl: meta.webpageUrl,
                truncated: false,
                radio: meta.radio,
              },
              entries: [],
            });
            setSelected(new Set());
            setMode("all");
            modeRef.current = "all";
            setStreaming(true);
            setProbing(false);
          },

          onEntries: (batch) => {
            if (stale()) return;
            received += batch.length;
            setProbeResult((prev) =>
              prev && prev.kind === "playlist"
                ? { ...prev, entries: [...prev.entries, ...batch] }
                : prev,
            );
            // "Select all" has to keep covering videos that arrive later.
            if (modeRef.current === "all") {
              const fresh = seedableIds(batch);
              if (fresh.length === 0) return;
              setSelected((prev) => {
                const next = new Set(prev);
                for (const id of fresh) next.add(id);
                return next;
              });
            }
          },

          onDone: ({ ok, truncated }) => {
            if (!stale()) {
              setStreaming(false);
              setProbeResult((prev) =>
                prev?.playlist
                  ? {
                      ...prev,
                      playlist: { ...prev.playlist, truncated: !!truncated },
                    }
                  : prev,
              );
            }
            resolve(ok && received > 0);
          },
        });

        probeCancelRef.current = () => {
          cancel();
          resolve(false);
        };
      });

      if (streamed || stale()) return;
    }

    // Fallback: single videos, and playlist URLs that resolve to one video.
    const controller = new AbortController();
    probeRequestRef.current = controller;
    try {
      const result = await api.probe(normalized, controller.signal);
      if (stale() || controller.signal.aborted) return;
      setProbeResult(result);
      // A playlist starts fully selected — the common case is "all of it", and
      // the mode switch narrows it down from there. A single video is now the
      // one-row list it always was visually, so it arrives as a one-row
      // selection. Either way, anything already in flight stays out.
      if (result.kind === "playlist") {
        setSelected(new Set(seedableIds(result.entries)));
        setMode("all");
        modeRef.current = "all";
      } else if (result.video) {
        const entry = videoMetaToEntry(result.video, normalized);
        setSelected(new Set(seedableIds([entry])));
        setMode("single");
        modeRef.current = "single";
      } else {
        setSelected(new Set());
      }
    } catch (err) {
      if (stale()) return;
      setProbeError(
        err instanceof Error ? err.message : "Could not load that URL.",
      );
      setProbeResult(null);
    } finally {
      if (probeRequestRef.current === controller)
        probeRequestRef.current = null;
      if (!stale()) {
        setProbing(false);
        setStreaming(false);
      }
    }
  }, [clearBatchContext, seedableIds]);

  // Debounced auto-fetch: paste a URL and it just loads.
  useEffect(() => {
    probeGenerationRef.current++;
    probeCancelRef.current?.();
    probeRequestRef.current?.abort();
    setProbing(false);
    setStreaming(false);
    if (!url.trim()) {
      setProbeResult(null);
      return;
    }
    const timer = setTimeout(() => void runProbe(url), 400);
    return () => {
      clearTimeout(timer);
      probeGenerationRef.current++;
      probeCancelRef.current?.();
      probeRequestRef.current?.abort();
    };
  }, [url, runProbe]);

  // Preview fetch. Deliberately independent of runProbe: it only needs the URL
  // to *look* like a playlist, and it answers in one request, so it can start
  // earlier and finish long before the playlist has been enumerated.
  useEffect(() => {
    const normalized = normalizeUrl(url);
    if (!normalized || !isPlaylistUrl(normalized)) {
      setPreview(null);
      setPreviewPending(false);
      return;
    }

    const controller = new AbortController();
    setPreviewPending(true);

    const timer = setTimeout(async () => {
      try {
        const result = await api.playlistPreview(normalized, controller.signal);
        if (controller.signal.aborted) return;
        setPreview(result);
      } catch {
        // The full probe is the one that reports real failures; a missed
        // preview just leaves the strip out rather than showing a second error.
        if (!controller.signal.aborted) setPreview(null);
      } finally {
        if (!controller.signal.aborted) setPreviewPending(false);
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url]);

  const handleGroupChange = (next: "video" | "audio") => {
    setGroup(next);
    const first = presets.filter((p) => p.group === next)[0];
    if (first) setPresetId(first.id);
  };

  /**
   * Turns a set of video ids into download items.
   *
   * Shared by the download button and the re-check so both describe the exact
   * same request -- including the playlist context that gets stored with the
   * finished file. If they differed, the plan would describe one request and
   * the queue would carry out another.
   */
  const buildItems = useCallback(
    (ids: Set<string>): DownloadItem[] => {
      if (!probeResult) return [];

      if (probeResult.kind === "video" && probeResult.video) {
        const v = probeResult.video;
        return [
          {
            url: v.webpageUrl ?? url,
            videoId: v.id,
            title: v.title,
            thumbnail: v.thumbnail,
          },
        ];
      }

      if (probeResult.kind !== "playlist") return [];

      // Walk entries rather than the id set so jobs queue in playlist order.
      const chosen = probeResult.entries.filter((e) => ids.has(e.id));
      const context: PlaylistDownloadContext = {
        playlistId: probeResult.playlist?.id,
        playlistTitle: probeResult.playlist?.title,
        selectionMode: mode,
        selectionCount: chosen.length,
        selectionFingerprint: buildSelectionFingerprint(
          chosen.map((e) => e.id),
        ),
      };

      // A batch has no playlist behind it. Sending the URL box's contents would
      // record whichever playlist happened to be loaded as the source of every
      // pasted video, so the field is simply left off. It is provenance only and
      // never affects the skip/convert decision.
      if (!probeResult.playlist?.batch) {
        context.playlistUrl =
          probeResult.playlist?.webpageUrl ?? normalizeUrl(url) ?? url;
      }

      return chosen.map((e) => ({
        url: e.url,
        videoId: e.id,
        title: e.title,
        thumbnail: e.thumbnail,
        playlistIndex: e.index,
        playlist: { ...context, entryIndex: e.index },
      }));
    },
    [probeResult, url, mode],
  );

  /**
   * Re-checks the selected videos we already hold a copy of.
   *
   * Scoped to `ownedIds` rather than the whole selection: asking the server
   * what it would do about 200 unwatched videos means 200 network probes to
   * conclude "download", which we already knew.
   */
  const planningRequest = useRef<AbortController | null>(null);
  const reevaluate = useCallback(async () => {
    planningRequest.current?.abort();
    const controller = new AbortController();
    planningRequest.current = controller;
    if (!probeResult) {
      setSelectionPlan([]);
      setPlanCounts(null);
      return;
    }

    // Playlists re-check the selection; a single video re-checks itself. Either
    // way only copies we already hold, which are the only ones that can come
    // back as skip or convert.
    const held =
      probeResult.kind === "playlist"
        ? probeResult.entries
            .filter((e) => selected.has(e.id) && ownedIds.has(e.id))
            .map((e) => e.id)
        : probeResult.video && ownedIds.has(probeResult.video.id)
          ? [probeResult.video.id]
          : [];

    if (held.length === 0) {
      setSelectionPlan([]);
      setPlanCounts(null);
      return;
    }

    setPlanning(true);
    setPlanError(null);
    try {
      const items = buildItems(new Set(held)).slice(0, REEVALUATE_CAP);
      const result = await api.planBatch(
        presetId,
        options,
        items,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setSelectionPlan(result.entries);
      setPlanCounts(result.counts);
    } catch (err) {
      if (controller.signal.aborted) return;
      setPlanError(
        err instanceof Error
          ? err.message
          : "Could not re-check this selection.",
      );
      setSelectionPlan([]);
      setPlanCounts(null);
    } finally {
      if (!controller.signal.aborted) setPlanning(false);
    }
  }, [probeResult, selected, ownedIds, buildItems, presetId, options]);

  // The effect below must only fire on a change of request, but it needs the
  // current closure to build one. A ref breaks that dependency without
  // re-planning on every unrelated re-render.
  const reevaluateRef = useRef(reevaluate);
  useEffect(() => {
    reevaluateRef.current = reevaluate;
  }, [reevaluate]);

  /**
   * A change of format or quality re-checks the selection automatically.
   *
   * Keyed on the request alone and not the selection: re-probing on every
   * checkbox click would hit the network for a decision nobody asked about.
   */
  useEffect(() => {
    planningRequest.current?.abort();
    setSelectionPlan([]);
    setPlanCounts(null);
    setPlanning(false);
    const timer = setTimeout(() => void reevaluateRef.current(), 700);
    return () => {
      clearTimeout(timer);
      planningRequest.current?.abort();
    };
    // `ownedIds` is here because the set is refetched whenever the request
    // changes or a download lands: without it, a format switch would re-check
    // against a stale idea of what is on disk.
  }, [requestKey, ownedIds, url, selected]);

  /** Queues the rows the re-check flagged, leaving the up-to-date ones alone. */
  const applySelection = async () => {
    const stale = new Set(
      selectionPlan
        .filter((e) => e.action !== "skip" && e.videoId)
        .map((e) => e.videoId!),
    );
    const items = stale.size > 0 ? buildItems(stale) : [];
    if (items.length === 0) return;

    try {
      const { jobs: queued } = await api.download(presetId, options, items);
      if (queued?.length) useAppStore.getState().upsertJobs(queued);
      const count = queued?.length ?? items.length;
      toast.success(`Queued ${count} update${count === 1 ? "" : "s"}.`);
      // The queued jobs re-plan each video themselves, so keeping the preview
      // up would describe a state that is already being corrected.
      setSelectionPlan([]);
      setPlanCounts(null);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not queue updates.",
      );
    }
  };

  const startDownload = async () => {
    const items = buildItems(selected);
    if (items.length === 0) {
      toast.error("Select at least one video first.");
      return;
    }

    try {
      const { jobs: queued } = await api.download(presetId, options, items, {
        scheduledAt: batchSchedule,
      });
      // Paint the queue from the response itself. The live stream will keep
      // these rows up to date from here, but the click must feel instant.
      if (queued?.length) useAppStore.getState().upsertJobs(queued);
      const count = queued?.length ?? items.length;
      toast.success(
        batchSchedule
          ? `Scheduled ${count} download${count === 1 ? "" : "s"}.`
          : `Queued ${count} download${count === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start download.",
      );
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) setUrl(text.trim());
      else toast.error("Clipboard is empty.");
    } catch {
      toast.error("Clipboard blocked — paste with Ctrl+V.");
    }
  };

  /**
   * Per-video outcome of the last re-check. The row ladder reads it, so it
   * lives here and travels into the union rather than down a prop.
   */
  const planByVideo = useMemo(() => {
    const map: Record<string, PlanBatchEntry> = {};
    for (const entry of selectionPlan) {
      if (entry.videoId) map[entry.videoId] = entry;
    }
    return map;
  }, [selectionPlan]);

  /**
   * The probe, as a flat list of entries.
   *
   * A single video is one entry: `videoMetaToEntry` gives the row everything a
   * playlist entry carries, so the one-video case renders through the same list
   * and gains the progress, pause, retry and reveal it had no path to.
   */
  const entries = useMemo(() => {
    if (probeResult?.kind === "playlist") return probeResult.entries;
    if (probeResult?.kind === "video" && probeResult.video)
      return [videoMetaToEntry(probeResult.video, url)];
    return [];
  }, [probeResult, url]);

  const jobList = useMemo(() => Object.values(jobs), [jobs]);

  /**
   * One row per thing.
   *
   * The union, with the ladder that decides what each row is currently speaking
   * for. A selected video and a downloading video are the same row, which is why
   * nothing here needs a second list to stay in step with this one.
   */
  const rows = useMemo(
    () =>
      unifiedRows({
        entries,
        jobs: jobList,
        selected,
        planByVideo,
        downloadedIds,
        ownedIds,
      }),
    [entries, jobList, selected, planByVideo, downloadedIds, ownedIds],
  );

  /** What the section is doing right now: picking, working, or draining. */
  const section = useMemo(
    () => sectionMode(entries, jobList),
    [entries, jobList],
  );

  const selectionCount = useMemo(
    () => rows.reduce((n, r) => n + (r.selected ? 1 : 0), 0),
    [rows],
  );

  /**
   * Queued rows leave the selection, once, at the moment they gain a job.
   *
   * A standing "minus settled" filter would be wrong: a settled video the user
   * re-ticked would be pruned again on the next render, so nothing could ever
   * be queued twice. Tracking the *transition* keeps the tick sticky, which is
   * what makes "Download 0" mean "nothing left that I want".
   *
   * Driven off the store rather than off a phase, and the POST response's own
   * `upsertJobs` is what puts a row into the store, so the count updates in the
   * same tick as the click instead of waiting for the SSE stream.
   */
  useEffect(() => {
    const withJob = new Set<string>();
    for (const job of jobList) if (job.videoId) withJob.add(job.videoId);

    const gained: string[] = [];
    for (const id of withJob) if (!withJobRef.current.has(id)) gained.push(id);

    if (gained.length > 0) {
      setSelected((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const id of gained) if (next.delete(id)) changed = true;
        return changed ? next : prev;
      });
      for (const id of gained) withJobRef.current.add(id);
    }
  }, [jobList]);

  const openFolder = async () => {
    try {
      await api.openFolder();
    } catch {
      toast.error("Could not open the download folder.");
    }
  };

  const paletteActions = [
    { label: "Open downloads folder", run: () => void openFolder() },
    { label: "Open settings", run: () => setSettingsOpen(true) },
    { label: "Switch to Library", run: () => setView("history") },
    { label: "Switch to Download", run: () => setView("download") },
    {
      label: "Clear finished jobs",
      run: () => {
        void api
          .clearJobs()
          .then(() => toast.success("Cleared finished jobs."));
      },
    },
    { label: "Check binaries", run: () => void refreshHealth() },
  ];

  // Once the playlist card has real entries the strip is redundant, and it
  // would wedge itself between the field and the table for the rest of the
  // session. Before that it is the only confirmation that the paste worked.
  const showPreview =
    (previewPending || preview !== null) &&
    !(probeResult?.kind === "playlist" && probeResult.entries.length > 0);

  const groupPresets = presets.filter((p) => p.group === group);
  const activePreset =
    groupPresets.find((p) => p.id === presetId) ?? groupPresets[0];
  const extLabel = activePreset ? activePreset.ext.toUpperCase() : "";
  const presetLabel = activePreset?.label ?? presetId;

  /** Dismiss button, shared by the two places the banner is rendered. */
  const dismissPlan = () => {
    setSelectionPlan([]);
    setPlanCounts(null);
  };

  const single = probeResult?.kind === "video" && !!probeResult.video;

  /**
   * The section's identity, folded into the list's own header.
   *
   * It lives here rather than in a card above so that the merged section can
   * also be the *only* thing on the page: after a reload there are jobs and no
   * probe result, and the `N queued` count has to be visible anyway.
   */
  const sectionHeader =
    probeResult?.kind === "playlist" && probeResult.playlist ? (
      <div className="min-w-0">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 text-[15px] font-medium leading-snug">
            {probeResult.playlist.batch
              ? "Pasted batch"
              : probeResult.playlist.title}
          </h2>
          {probeResult.playlist.batch ? (
            <Badge variant="outline" className="mt-0.5 shrink-0">
              Batch
            </Badge>
          ) : probeResult.playlist.radio ? (
            <Badge variant="warning" className="mt-0.5 shrink-0">
              Mix
            </Badge>
          ) : null}
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          {probeResult.playlist.batch ? (
            <>
              {probeResult.entries.length} loaded
              {batchSchedule
                ? ` · runs ${new Date(batchSchedule).toLocaleString()}`
                : ""}
            </>
          ) : (
            <>
              {probeResult.playlist.uploader
                ? `${probeResult.playlist.uploader} · `
                : ""}
              {probeResult.entries.length} videos
              {probeResult.playlist.truncated
                ? ` (capped at ${probeResult.playlist.radio ? 30 : (settings?.playlistCap ?? 200)})`
                : ""}
            </>
          )}
          {streaming ? (
            <span className="inline-flex items-center gap-1 text-faint">
              <HugeiconsIcon
                icon={Loading03Icon}
                className="h-3 w-3 animate-spin"
              />
              loading more…
            </span>
          ) : null}
        </p>
        {/* A line the server could not read would otherwise look identical to
            one that was never pasted. */}
        {batchErrors.length > 0 ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-destructive">
              {batchErrors.length} link
              {batchErrors.length === 1 ? "" : "s"} could not be read
            </summary>
            <ul className="mt-2 space-y-1 text-[11px] text-muted-foreground">
              {batchErrors.map((error, index) => (
                <li key={index}>{error}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    ) : undefined;

  const revalidation = (
    <RevalidationBanner
      className="mb-2.5"
      planning={planning}
      counts={planCounts}
      checked={selectionPlan.length}
      error={planError}
      formatLabel={extLabel}
      onApply={() => void applySelection()}
      onDismiss={dismissPlan}
    />
  );

  /**
   * Sticky to the bottom of the section, outside the row scroller, so picking
   * rows and starting them are one gesture with no scroll back up. The count
   * and duration already live in the stats bar directly above.
   */
  const sectionFooter = single ? (
    <>
      {revalidation}
      <Button
        size="lg"
        className="w-full"
        onClick={() => void startDownload()}
      >
        <HugeiconsIcon icon={Download04Icon} className="mr-2 h-4 w-4" />
        {`Download${extLabel ? ` · ${extLabel}` : ""}`}
      </Button>
    </>
  ) : (
    <>
      {revalidation}
      <Button
        size="lg"
        className="w-full"
        // Once work is in flight the button stays live and reads "Download 0",
        // because the selection drained into the queue rather than because
        // there is nothing to do. Re-ticking a finished row and pressing again
        // has to stay a two-gesture action.
        disabled={selectionCount === 0 && section !== "work"}
        onClick={() => void startDownload()}
      >
        <HugeiconsIcon icon={Download04Icon} className="mr-2 h-4 w-4" />
        {`Download ${selectionCount}${extLabel ? ` · ${extLabel}` : ""}`}
      </Button>
    </>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster position="bottom-right" />

      <main
        className={cn(
          "mx-auto w-full px-5 py-12 transition-[max-width] duration-300 sm:py-14",
          // A multi-column grid inside a 672px column looks broken, so the shell
          // widens with the layout rather than the grid being capped to fit.
          layout === "grid" ? "max-w-5xl" : "max-w-2xl",
        )}
      >
        <header className="mb-10 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm">
              <BrandMark className="h-5 w-5 shrink-0 text-foreground" />
              Reelcreel
            </div>
            <h1 className="mt-5 text-2xl font-semibold tracking-tight">
              YouTube downloader
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Video, audio, playlists, captions, thumbs.
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {health?.ytdlp ? (
                <span className="chip">yt-dlp {health.ytdlp.version}</span>
              ) : null}
              {health?.ffmpeg ? (
                <span className="chip">ffmpeg {health.ffmpeg.version}</span>
              ) : null}
              {health && !health.ok ? (
                <Badge variant="destructive">
                  <HugeiconsIcon
                    icon={AlertCircleIcon}
                    className="mr-1 h-3 w-3"
                  />
                  {health.error ?? "Binary missing"}
                </Badge>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() => {
                setView(view === "download" ? "history" : "download");
                if (view === "download") libraryChanged();
              }}
            >
              {view === "download" ? (
                <>
                  <HugeiconsIcon
                    icon={LibraryIcon}
                    className="mr-1.5 h-3.5 w-3.5"
                  />
                  Library
                </>
              ) : (
                <>
                  <HugeiconsIcon
                    icon={Download04Icon}
                    className="mr-1.5 h-3.5 w-3.5"
                  />
                  Download
                </>
              )}
            </Button>
            <ThemeToggle />
            {view === "download" ? <ViewToggle /> : null}
            <Button
              variant="ghost"
              size="icon"
              title="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <HugeiconsIcon icon={Settings01Icon} className="h-4 w-4" />
            </Button>
          </div>
        </header>

        {view === "download" ? (
          <>
            <section className="rounded-2xl border border-border bg-card p-2">
              <div className="flex items-center gap-1">
                <Input
                  aria-label="YouTube URL"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Paste YouTube URL"
                  spellCheck={false}
                  className="h-11 flex-1 border-0 bg-transparent px-4 text-sm focus-visible:ring-0"
                />
                <button
                  type="button"
                  onClick={() => void pasteFromClipboard()}
                  className="shrink-0 cursor-pointer px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  Paste
                </button>
                <Button
                  className="shrink-0 rounded-xl px-4 py-2 text-sm"
                  onClick={() => void runProbe(url)}
                  disabled={probing || !url.trim()}
                >
                  {probing ? (
                    <HugeiconsIcon
                      icon={Loading03Icon}
                      className="h-4 w-4 animate-spin"
                    />
                  ) : (
                    "Fetch"
                  )}
                </Button>
              </div>
            </section>

            {showPreview ? (
              <PlaylistPreviewCard
                key={preview?.entry.id ?? "pending"}
                preview={preview}
                pending={previewPending}
              />
            ) : null}

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {SOURCE_CHIPS.map((chip) => (
                <span key={chip} className="chip">
                  {chip}
                </span>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-faint">
              Loads automatically as you paste. Playlists and YouTube Mixes list
              every video — pick what you want, then download.
            </p>

            {/* A second way to supply links, sitting beside the URL box rather
                than below the page, and sharing the one format selection below.
                It used to sit at the bottom of the page carrying a per-row
                format dropdown, and then queue every pasted line immediately --
                which made a batch the one place where neither the chosen format
                nor the choice of videos could be made first. */}
            <BatchComposer onLoad={loadBatch} />

            {/* One format decision, always present, driving the URL box, the
                batch composer, the selection table and the library alike. */}
            <Card className="mt-4 overflow-hidden">
              <FormatPicker
                presets={presets}
                group={group}
                presetId={presetId}
                options={options}
                onGroupChange={handleGroupChange}
                onPresetChange={setPresetId}
                onOptionsChange={setOptions}
              />
              <div className="border-t border-border px-5 pb-5">
                <p className="micro mb-2">Saves to</p>
                <p
                  className="field-box truncate"
                  title={settings?.outputDir}
                >
                  {settings?.outputDir ?? "Default download folder"}
                </p>
              </div>
              <SourceFormats
                url={probeResult?.video?.webpageUrl ?? (probeResult?.video ? url : "")}
              />
            </Card>

            {probing ? (
              <Card className="mt-6 flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <HugeiconsIcon
                  icon={Loading03Icon}
                  className="h-4 w-4 animate-spin"
                />
                Loading metadata…
              </Card>
            ) : null}

            {probeError ? (
              <Card className="mt-6 flex items-start gap-2 border-destructive/40 p-4 text-sm">
                <HugeiconsIcon
                  icon={AlertCircleIcon}
                  className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
                />
                <span>{probeError}</span>
              </Card>
            ) : null}

            {/* A single video keeps its metadata card -- description, uploader,
                view count, upload date -- and the row beneath it is the same
                row a playlist uses, with the same sticky footer. That is how
                the one-video case gains progress, pause, retry and reveal. */}
            {single && probeResult.video ? (
              <Card className="mt-6 overflow-hidden">
                <MetadataCard video={probeResult.video} />
              </Card>
            ) : null}

            {/* One section, doing the work of both. It is on the page whenever
                there is something to show: a probe, or jobs that survived a
                reload with nothing to attach them to. */}
            {probeResult || jobList.length > 0 ? (
              <PlaylistTable
                className="mt-6"
                rows={rows}
                sectionMode={section}
                mode={mode}
                onSelectionChange={setSelected}
                onModeChange={setMode}
                layout={layout}
                header={sectionHeader}
                footer={sectionFooter}
              />
            ) : null}

            {probeResult?.playlist?.truncated ? (
              <p role="status" className="mt-3 text-sm text-muted-foreground">
                This playlist reached the configured cap. Only the loaded
                entries are included.
              </p>
            ) : null}
          </>
        ) : (
          <Suspense fallback={<p role="status">Loading library…</p>}>
            <LibraryManager
              presetId={presetId}
              options={options}
              presets={presets}
            />
          </Suspense>
        )}

        <footer className="mt-14 flex flex-wrap items-center justify-between gap-2 text-[11px] text-faint">
          <span>Not affiliated with YouTube.</span>
          <span className="flex items-center gap-1.5">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                connected ? "bg-emerald-400" : "bg-amber-400"
              }`}
            />
            {connected ? "Live updates connected" : "Reconnecting…"}
          </span>
        </footer>
      </main>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        health={health}
        onSaved={(s: SettingsType) => {
          setSettings(s);
          void refreshHealth();
          toast.success("Settings saved.");
        }}
      />

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        actions={paletteActions}
      />
    </div>
  );
}
