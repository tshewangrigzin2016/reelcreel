import { compatibilityError } from "@shared/validation";
import type { DownloadOptions, Preset } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { Field, Switch } from "@/components/ui/controls";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Props {
  presets: Preset[];
  group: "video" | "audio";
  presetId: string;
  options: DownloadOptions;
  onGroupChange: (g: "video" | "audio") => void;
  onPresetChange: (id: string) => void;
  onOptionsChange: (o: DownloadOptions) => void;
}

/** Offered as a cap on the source; anything above the source is pointless. */
const HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240, 144];

export function FormatPicker({
  presets,
  group,
  presetId,
  options,
  onGroupChange,
  onPresetChange,
  onOptionsChange,
}: Props) {
  const groupPresets = presets.filter((p) => p.group === group);
  const active = groupPresets.find((p) => p.id === presetId) ?? groupPresets[0];
  const set = (patch: Partial<DownloadOptions>) =>
    onOptionsChange({ ...options, ...patch });

  /** Same control twice (one per tab), so the id has to differ to keep <label> unique. */
  const presetSelect = (id: string) => (
    <Field label="Format" htmlFor={id}>
      <Select value={presetId} onValueChange={onPresetChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Choose a format" />
        </SelectTrigger>
        <SelectContent>
          {groupPresets.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );

  return (
    <div>
      <Tabs
        value={group}
        onValueChange={(v) => onGroupChange(v as "video" | "audio")}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5">
          <TabsList>
            <TabsTrigger value="video">Video</TabsTrigger>
            <TabsTrigger value="audio">Audio</TabsTrigger>
          </TabsList>
          {active?.instant ? (
            <Badge
              variant="success"
              title="Copies existing streams — seconds, no quality loss"
            >
              Instant remux
            </Badge>
          ) : (
            <Badge variant="warning">Re-encodes</Badge>
          )}
        </div>

        <TabsContent value="video">
          <div className="px-5 pt-5">{presetSelect("preset-video")}</div>
        </TabsContent>

        <TabsContent value="audio">
          <div className="px-5 pt-5">{presetSelect("preset-audio")}</div>
        </TabsContent>
      </Tabs>

      {compatibilityError(presetId, options) ? (
        <p role="alert" className="px-5 pt-3 text-xs text-destructive">
          {compatibilityError(presetId, options)}
        </p>
      ) : null}
      {active?.note ? (
        <p className="px-5 pt-3 text-xs leading-relaxed text-muted-foreground">
          {active.note}
        </p>
      ) : null}
      <p className="px-5 pt-3 text-[11px] leading-relaxed text-faint">
        Changing format or quality re-checks existing files against the full
        source and file metadata; the next download uses an exact skip, FFmpeg
        conversion, or fresh download as needed.
      </p>

      {group === "audio" ? (
        <p className="mx-5 mt-3 rounded-lg bg-secondary/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          YouTube's best audio is Opus at roughly 128–160 kbps. Encoding to 320
          kbps MP3 does not add detail that isn't in the source — it just makes
          a bigger file. For the best real quality per megabyte, pick{" "}
          <span className="text-foreground">WebM · native Opus</span>.
        </p>
      ) : null}

      <div className="space-y-3 px-5 pt-5">
        <p className="micro">Options</p>
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <label className="flex items-center justify-between gap-3 text-xs">
            <span>Embed thumbnail</span>
            <Switch
              checked={options.embedThumbnail}
              onCheckedChange={(v) => set({ embedThumbnail: v })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-xs">
            <span>Write metadata</span>
            <Switch
              checked={options.embedMetadata}
              onCheckedChange={(v) => set({ embedMetadata: v })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-xs">
            <span>Embed chapters</span>
            <Switch
              checked={options.embedChapters}
              onCheckedChange={(v) => set({ embedChapters: v })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-xs">
            <span>Remove sponsor segments</span>
            <Switch
              checked={options.sponsorblock}
              onCheckedChange={(v) => set({ sponsorblock: v })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-xs">
            <span>Download subtitles</span>
            <Switch
              checked={options.subtitles}
              onCheckedChange={(v) => set({ subtitles: v })}
            />
          </label>
          {options.subtitles ? (
            <Field label="Subtitle languages">
              <Input
                value={options.subtitleLangs}
                onChange={(e) => set({ subtitleLangs: e.target.value })}
                placeholder="en.*"
              />
            </Field>
          ) : null}
        </div>
      </div>

      {/* These used to live in a separate "Quality, captions and source formats"
          panel below the whole page, which meant the format you were about to
          change and the controls that describe it were on opposite sides of a
          long scroll. */}
      <div className="space-y-3 border-t border-border px-5 pb-5 pt-5">
        <p className="micro">Quality and captions</p>
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Field
            label="Maximum height"
            hint="Caps the source; never upscales"
          >
            <Select
              value={options.maxHeight ? String(options.maxHeight) : "best"}
              onValueChange={(v) =>
                set({ maxHeight: v === "best" ? undefined : Number(v) })
              }
            >
              <SelectTrigger aria-label="Maximum height">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="best">Best available</SelectItem>
                {HEIGHTS.map((h) => (
                  <SelectItem key={h} value={String(h)}>
                    {h}p
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field
            label="Preferred audio language"
            hint="Falls back to any available track"
          >
            <Input
              value={options.audioLanguage ?? ""}
              onChange={(e) =>
                set({ audioLanguage: e.target.value || undefined })
              }
              placeholder="e.g. en"
            />
          </Field>

          <Field label="Caption source">
            <Select
              value={options.subtitleSource ?? "both"}
              onValueChange={(v) =>
                set({
                  subtitleSource: v as NonNullable<
                    DownloadOptions["subtitleSource"]
                  >,
                })
              }
            >
              <SelectTrigger aria-label="Caption source">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="both">Manual and automatic</SelectItem>
                <SelectItem value="manual">Manual only</SelectItem>
                <SelectItem value="automatic">Automatic only</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label="Caption output">
            <Select
              value={options.subtitleMode ?? "embedded"}
              onValueChange={(v) =>
                set({
                  subtitleMode: v as NonNullable<
                    DownloadOptions["subtitleMode"]
                  >,
                })
              }
            >
              <SelectTrigger aria-label="Caption output">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="embedded">Embed in media</SelectItem>
                <SelectItem value="sidecar">Separate caption file</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </div>
    </div>
  );
}
